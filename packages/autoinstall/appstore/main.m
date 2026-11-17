#import <Foundation/Foundation.h>
#import <StoreKit/StoreKit.h>
#import <dlfcn.h>
#import <fcntl.h>
#import <sys/file.h>
#import <grp.h>
#import <unistd.h>
#import "InstallSupport.h"

@protocol AIStore <NSObject>
@optional
+ (id)defaultBroker;
+ (id)defaultStore;
+ (id)sharedInstance;
- (id)getPurchaseServiceWithError:(NSError **)error;
- (void)startPurchase:(id)purchase withReplyHandler:(void (^)(id, NSError *))reply;
- (id)activeAccount;
- (id)uniqueIdentifier;
- (BOOL)isBiometricStateEnabled;
- (BOOL)isIdentityMapValidForAccountIdentifier:(NSString *)identifier;
- (void)setBiometricState:(long long)value;
- (void)updateForAccountID:(long long)account withContext:(unsigned long long)context withCompletionHandler:(void (^)(NSError *))reply;
- (void)executeQuery:(id)query withResultHandler:(void (^)(NSArray *, NSError *))reply;
- (BOOL)success;
- (NSError *)error;
- (NSString *)bundleID;
@end

static id<AIStore> AIClass(NSString *name) { return (id)NSClassFromString(name); }

static void AIPrint(NSDictionary *result) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    if (json) { fwrite(json.bytes, 1, json.length, stdout); fputc('\n', stdout); }
}

static BOOL AIWait(BOOL (^done)(void), NSTimeInterval seconds) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return done();
}

static BOOL AILoad(void) {
    dlopen("/System/Library/PrivateFrameworks/StoreServices.framework/StoreServices", RTLD_NOW);
    dlopen("/System/Library/PrivateFrameworks/AppleMediaServices.framework/AppleMediaServices", RTLD_NOW);
    dlopen("/System/Library/PrivateFrameworks/iTunesStore.framework/iTunesStore", RTLD_NOW);
    dlopen("/System/Library/PrivateFrameworks/AppStoreDaemon.framework/AppStoreDaemon", RTLD_NOW);
    Class purchase = NSClassFromString(@"ASDPurchase");
    if (!purchase || ![AIClass(@"ASDServiceBroker") respondsToSelector:@selector(defaultBroker)]) return NO;
    for (NSString *selector in @[@"setBundleID:", @"setItemID:", @"setBuyParameters:", @"setPurchaseID:", @"setIsRedownload:", @"setCreatesJobs:", @"setClientID:"]) {
        if (![purchase instancesRespondToSelector:NSSelectorFromString(selector)]) return NO;
    }
    return YES;
}

static NSString *AIBiometricPreflight(BOOL repair) {
    id<AIStore> cls = AIClass(@"ISBiometricStore");
    if (![cls respondsToSelector:@selector(sharedInstance)]) return @"unavailable";
    id<AIStore> bio = [cls sharedInstance];
    if (![bio respondsToSelector:@selector(isBiometricStateEnabled)] || ![bio respondsToSelector:@selector(isIdentityMapValidForAccountIdentifier:)]) return @"unavailable";
    if (![bio isBiometricStateEnabled]) return @"disabled";
    id<AIStore> store = AIClass(@"SSAccountStore");
    if (![store respondsToSelector:@selector(defaultStore)]) return @"unavailable";
    id<AIStore> account = [[store defaultStore] activeAccount];
    if (![account respondsToSelector:@selector(uniqueIdentifier)]) return @"unavailable";
    id rawID = [account uniqueIdentifier];
    NSString *identifier = [rawID isKindOfClass:NSString.class] ? rawID : ([rawID isKindOfClass:NSNumber.class] ? [rawID stringValue] : nil);
    if (!identifier.length) return @"no_account";
    if ([bio isIdentityMapValidForAccountIdentifier:identifier]) return @"valid_identity";
    if (!repair) return @"invalid_identity";
    // The helper is exclusively mobile. Root would read a different preferences domain.
    if (getuid() != 501) return @"wrong_user";
    if ([bio respondsToSelector:@selector(setBiometricState:)]) [bio setBiometricState:0];
    for (NSString *key in @[@"BiometricState", @"BiometricStateEnabled"]) {
        CFPreferencesSetValue((__bridge CFStringRef)key, (__bridge CFNumberRef)@0,
            CFSTR("com.apple.itunesstored"), kCFPreferencesCurrentUser, kCFPreferencesAnyHost);
    }
    if (!CFPreferencesAppSynchronize(CFSTR("com.apple.itunesstored"))) return @"repair_failed";
    return [bio isBiometricStateEnabled] ? @"repair_failed" : @"repaired";
}

static NSString *AIStorefront(void) {
    // StoreKit's payment storefront does not require Apple Music permission.
    // The cloud-service fallback can be unavailable to a standalone helper.
    NSString *paymentCountry = [SKPaymentQueue defaultQueue].storefront.countryCode.uppercaseString;
    if (paymentCountry.length == 3) return paymentCountry;
    __block BOOL done = NO;
    __block NSString *country = nil;
    SKCloudServiceController *controller = [SKCloudServiceController new];
    [controller requestStorefrontCountryCodeWithCompletionHandler:^(NSString *code, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{ country = error ? nil : code.uppercaseString; done = YES; });
    }];
    AIWait(^BOOL{ return done; }, 10);
    return country;
}

static BOOL AIOwned(NSString *bundleID) {
    id<AIStore> historyClass = AIClass(@"ASDPurchaseHistory");
    Class queryClass = NSClassFromString(@"ASDPurchaseHistoryQuery");
    id<AIStore> store = AIClass(@"SSAccountStore");
    if (!queryClass || ![historyClass respondsToSelector:@selector(sharedInstance)] || ![store respondsToSelector:@selector(defaultStore)]) return NO;
    id<AIStore> account = [[store defaultStore] activeAccount];
    id accountID = [account respondsToSelector:@selector(uniqueIdentifier)] ? [account uniqueIdentifier] : nil;
    if (![accountID respondsToSelector:@selector(longLongValue)] || [accountID longLongValue] <= 0) return NO;
    id<AIStore> history = [historyClass sharedInstance];
    if (![history respondsToSelector:@selector(executeQuery:withResultHandler:)]) return NO;
    __block BOOL refreshed = NO;
    if ([history respondsToSelector:@selector(updateForAccountID:withContext:withCompletionHandler:)]) {
        [history updateForAccountID:[accountID longLongValue] withContext:0 withCompletionHandler:^(NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{ refreshed = YES; });
        }];
        AIWait(^BOOL{ return refreshed; }, 8);
    }
    id query = [queryClass new];
    [query setValue:@([accountID longLongValue]) forKey:@"accountID"];
    [query setValue:@[bundleID] forKey:@"bundleIDs"];
    __block BOOL done = NO;
    __block BOOL owned = NO;
    [history executeQuery:query withResultHandler:^(NSArray *apps, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            // Some OS releases ignore the query filter and return the entire library.
            if (!error && [apps isKindOfClass:NSArray.class]) for (id<AIStore> app in apps) {
                if ([app respondsToSelector:@selector(bundleID)] && [[app bundleID] isEqual:bundleID]) { owned = YES; break; }
            }
            done = YES;
        });
    }];
    AIWait(^BOOL{ return done; }, 8);
    return owned;
}

static NSDictionary *AIPurchase(NSDictionary *request) {
    if (!AIValidInstallRequest(request)) return @{@"ok": @NO, @"error": @"invalid verified-free install request"};
    if (!AILoad()) return @{@"ok": @NO, @"error": @"App Store direct backend is unavailable", @"submitted": @NO};
    NSString *directory = @"/var/mobile/Library/Caches/dev.adrian.autoinstall.appstore";
    if (![NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil]) return @{@"ok": @NO, @"error": @"could not create purchase transaction directory"};
    NSString *path = [directory stringByAppendingPathComponent:[request[@"operationId"] stringByAppendingString:@".plist"]];
    int lock = open([[path stringByAppendingString:@".lock"] fileSystemRepresentation], O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (lock < 0) return @{@"ok": @NO, @"error": @"could not lock purchase transaction"};
    if (flock(lock, LOCK_EX | LOCK_NB) != 0) { close(lock); return @{@"ok": @NO, @"error": @"purchase operation is already in progress"}; }
    @try {
        NSDictionary *previous = [NSDictionary dictionaryWithContentsOfFile:path];
        if (previous) {
            if (![previous[@"request"] isEqual:request]) return @{@"ok": @NO, @"error": @"purchase operation ID was reused with a different request"};
            return previous[@"result"] ?: @{@"ok": @NO, @"error": @"App Store purchase outcome is unknown; inspect the device before retrying", @"submitted": @YES};
        }
        NSString *biometric = AIBiometricPreflight(YES);
        BOOL owned = AIOwned(request[@"bundleId"]);
        id purchase = [NSClassFromString(@"ASDPurchase") new];
        [purchase setValue:request[@"bundleId"] forKey:@"bundleID"];
        [purchase setValue:@([request[@"adamId"] longLongValue]) forKey:@"itemID"];
        NSMutableString *parameters = [NSMutableString stringWithFormat:@"salableAdamId=%@&productType=C&price=0&pricingParameters=%@&hasBeenAuthedForBuy=true&hasConfirmedPaymentSheet=true", request[@"adamId"], owned ? @"STDRDL" : @"STDQ"];
        if (request[@"versionId"]) [parameters appendFormat:@"&appExtVrsId=%@", request[@"versionId"]];
        [purchase setValue:parameters forKey:@"buyParameters"];
        [purchase setValue:@(owned) forKey:@"isRedownload"];
        [purchase setValue:@YES forKey:@"createsJobs"];
        [purchase setValue:@"com.apple.AppStore" forKey:@"clientID"];
        [purchase setValue:@((long long)arc4random_uniform(0x7ffffffe) + 1) forKey:@"purchaseID"];
        NSError *error = nil;
        // Acquire once. A second proxy invalidates an outstanding purchase reply.
        id<AIStore> broker = [AIClass(@"ASDServiceBroker") defaultBroker];
        id<AIStore> service = [broker getPurchaseServiceWithError:&error];
        if (!service || ![service respondsToSelector:@selector(startPurchase:withReplyHandler:)]) return @{@"ok": @NO, @"error": @"App Store purchase service is unavailable", @"details": AIStoreError(error), @"submitted": @NO};
        if (![@{@"request": request} writeToFile:path atomically:YES]) return @{@"ok": @NO, @"error": @"could not persist purchase transaction", @"submitted": @NO};
        __block BOOL done = NO;
        __block NSDictionary *result = nil;
        [service startPurchase:purchase withReplyHandler:^(id<AIStore> response, NSError *failure) {
            dispatch_async(dispatch_get_main_queue(), ^{
                BOOL success = [response respondsToSelector:@selector(success)] && [response success];
                NSError *purchaseError = [response respondsToSelector:@selector(error)] ? [response error] : nil;
                NSDictionary *details = AIStoreError(purchaseError ?: failure);
                result = success ? @{@"ok": @YES, @"state": @"purchased", @"biometric": biometric, @"redownload": @(owned)} :
                    @{@"ok": @NO, @"error": details[@"message"], @"details": details, @"biometric": biometric, @"submitted": @YES};
                done = YES;
            });
        }];
        if (!AIWait(^BOOL{ return done; }, 75)) result = @{@"ok": @NO, @"error": @"App Store purchase outcome is unknown after timeout; inspect the device before retrying", @"submitted": @YES};
        [@{@"request": request, @"result": result} writeToFile:path atomically:YES];
        return result;
    } @finally { flock(lock, LOCK_UN); close(lock); }
}

static NSDictionary *AIPurchaseOperation(NSDictionary *request) {
    if (!AIValidInstallRequest(request)) return @{@"ok": @NO, @"error": @"invalid verified-free install request"};
    NSString *path = [@"/var/mobile/Library/Caches/dev.adrian.autoinstall.appstore" stringByAppendingPathComponent:[request[@"operationId"] stringByAppendingString:@".plist"]];
    NSDictionary *previous = [NSDictionary dictionaryWithContentsOfFile:path];
    if (!previous) return @{@"ok": @YES, @"found": @NO};
    if (![previous[@"request"] isEqual:request]) return @{@"ok": @NO, @"error": @"purchase operation ID was reused with a different request"};
    NSDictionary *result = previous[@"result"];
    if (!result) return @{@"ok": @NO, @"error": @"App Store purchase outcome is unknown; inspect the device before retrying"};
    NSMutableDictionary *response = result.mutableCopy;
    response[@"found"] = @YES;
    return response;
}

int main(int argc, char **argv) {
    // SSH compatibility sessions can run as root. Re-exec before Foundation or
    // preferences are touched so account state always belongs to mobile.
    if (getuid() == 0) {
        if (initgroups("mobile", 501) != 0 || setgid(501) != 0 || setuid(501) != 0) return 1;
        execv(argv[0], argv);
        return 1;
    }
    @autoreleasepool {
        @try {
            if (getuid() != 501) { AIPrint(@{@"ok": @NO, @"error": @"App Store helper must run as mobile"}); return 1; }
            NSString *action = argc > 1 ? @(argv[1]) : @"";
            if ([action isEqual:@"probe"]) {
                BOOL supported = AILoad();
                NSError *error = nil;
                id<AIStore> broker = supported ? [AIClass(@"ASDServiceBroker") defaultBroker] : nil;
                if (![broker respondsToSelector:@selector(getPurchaseServiceWithError:)]) supported = NO;
                if (supported) supported = [broker getPurchaseServiceWithError:&error] != nil;
                NSMutableDictionary *result = [@{@"ok": @YES, @"supported": @(supported), @"protocol": @1} mutableCopy];
                if (supported) {
                    NSString *country = AIStorefront();
                    if ((country.length == 2 || country.length == 3) && AIIdentifier(country, @"ABCDEFGHIJKLMNOPQRSTUVWXYZ", 3)) {
                        result[@"countryCode"] = country;
                        result[@"biometric"] = AIBiometricPreflight(NO);
                    } else {
                        // No purchase has been submitted: let the host use the
                        // existing App Store client to verify its account country.
                        result[@"supported"] = @NO;
                        result[@"reason"] = @"storefront_unavailable";
                    }
                }
                AIPrint(result);
            } else if ([action isEqual:@"inspect"] && argc == 3) {
                NSString *bundleID = @(argv[2]);
                if (!AIIdentifier(bundleID, @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-", 200)) return 1;
                NSString *root = @"/var/containers/Bundle/Application";
                NSString *found = nil;
                for (NSString *container in [NSFileManager.defaultManager contentsOfDirectoryAtPath:root error:nil]) {
                    NSString *containerPath = [root stringByAppendingPathComponent:container];
                    for (NSString *name in [NSFileManager.defaultManager contentsOfDirectoryAtPath:containerPath error:nil]) {
                        NSString *path = [containerPath stringByAppendingPathComponent:name];
                        if ([name.pathExtension isEqual:@"app"] && AIInstalledBundleReady(path, bundleID)) { found = path; break; }
                    }
                    if (found) break;
                }
                AIPrint(@{@"ok": @YES, @"appPath": found ?: (id)NSNull.null});
            } else if (([action isEqual:@"install"] || [action isEqual:@"operation"]) && argc == 3) {
                NSData *data = [[NSData alloc] initWithBase64EncodedString:@(argv[2]) options:0];
                id request = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
                AIPrint([request isKindOfClass:NSDictionary.class] ? ([action isEqual:@"install"] ? AIPurchase(request) : AIPurchaseOperation(request)) : @{@"ok": @NO, @"error": @"invalid install request"});
            } else { AIPrint(@{@"ok": @NO, @"error": @"unsupported helper action"}); return 1; }
        } @catch (NSException *exception) {
            // Exception names are sufficient for diagnosis; reasons can include account data.
            AIPrint(@{@"ok": @NO, @"error": @"App Store private API failed", @"exception": exception.name ?: @"unknown"});
            return 1;
        }
    }
    return 0;
}
