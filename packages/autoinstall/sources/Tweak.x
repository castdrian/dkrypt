#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <CommonCrypto/CommonHMAC.h>
#import <dlfcn.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <spawn.h>
#import <errno.h>
#import <signal.h>
#import <fcntl.h>
#import <sys/file.h>
#import <sys/wait.h>
#import <unistd.h>
#import <math.h>
#import "FreeInstallConfirmation.h"
#import "PurchaseResponse.h"

extern char **environ;

static void runSpawnAsync(const char *path, char *const argv[]) {
    pid_t pid = 0;
    if (posix_spawn(&pid, path, NULL, NULL, argv, environ) != 0 || pid <= 0) return;
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        int status = 0;
        for (NSUInteger attempt = 0; attempt < 300; attempt++) {
            pid_t result = waitpid(pid, &status, WNOHANG);
            if (result == pid || (result < 0 && errno == ECHILD)) return;
            if (result < 0 && errno != EINTR) return;
            usleep(100000);
        }
        kill(pid, SIGTERM);
        for (NSUInteger attempt = 0; attempt < 10; attempt++) {
            pid_t result = waitpid(pid, &status, WNOHANG);
            if (result == pid || (result < 0 && errno == ECHILD)) return;
            if (result < 0 && errno != EINTR) return;
            usleep(100000);
        }
        kill(pid, SIGKILL);
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    });
}

@protocol TFNetworkManagerProtocol <NSObject>
+ (instancetype)shared;
- (id)enqueueDataTaskWithURL:(NSURL *)url completionHandler:(void (^)(id response))completionHandler;
@end

@protocol TFNetworkManagerResponseProtocol <NSObject>
- (id)data;
- (NSError *)error;
- (NSInteger)statusCode;
@end

@protocol TFAppCatalogManagerProtocol <NSObject>
- (id)getAppCatalogCachedAppForAppID:(id)appID;
@end

@protocol TFAppBuildProtocol <NSObject>
+ (instancetype)buildFromDictionary:(NSDictionary *)dict;
@end

@protocol TFInstallableBundleProtocol <NSObject>
- (instancetype)initWithApp:(id)app build:(id)build buildGroup:(id)buildGroup preinstalledState:(NSInteger)preinstalledState parentInstalledState:(NSInteger)parentInstalledState canAutoUpdate:(BOOL)canAutoUpdate allowReinstallSameVersion:(BOOL)allowReinstallSameVersion variant:(id)variant;
@end

@protocol TFAppInstallerProtocol <NSObject>
- (id)requestInstall:(id)installable installationMode:(id)mode alertDelegate:(id)delegate withBackgroundTaskMaster:(id)master completionBlock:(id)block;
@end

@protocol TFInstallationModeProtocol <NSObject>
+ (id)modeWithUserInitiated:(BOOL)userInitiated interactive:(BOOL)interactive autoUpdate:(BOOL)autoUpdate;
@end

@protocol TFInstallAlertDelegate <NSObject>
- (BOOL)presentPrecheckAlertWithType:(NSInteger)type installable:(id)installable completion:(void (^)(BOOL))completion;
@optional
- (void)dismissPrecheckAlert;
@end

@protocol SKUIItemStateCenterProtocol <NSObject>
+ (instancetype)defaultCenter;
- (id)_newPurchasesWithItems:(NSArray *)items;
- (void)_performPurchases:(id)purchases hasBundlePurchase:(BOOL)hasBundlePurchase withClientContext:(id)context completionBlock:(void (^)(id arg1))block;
@end

@protocol SKUIItemProtocol <NSObject>
- (instancetype)initWithLookupDictionary:(NSDictionary *)dict;
@end

@protocol SKUIItemOfferProtocol <NSObject>
- (instancetype)initWithLookupDictionary:(NSDictionary *)dict;
@end

@protocol SKUIClientContextProtocol <NSObject>
+ (instancetype)defaultContext;
+ (id)_fallbackConfigurationDictionary;
- (instancetype)initWithConfigurationDictionary:(NSDictionary *)dict;
@end

@protocol SBBacklightControllerProtocol <NSObject>
+ (instancetype)sharedInstance;
- (BOOL)screenIsOn;
- (BOOL)screenIsDim;
- (NSInteger)backlightState;
- (void)preventIdleSleep;
- (void)allowIdleSleep;
@end

@protocol BrightnessSystemClientProtocol <NSObject>
- (instancetype)init;
- (id)copyPropertyForKey:(NSString *)key;
- (BOOL)setProperty:(id)value forKey:(NSString *)key;
@end

static void autoinstallLog(NSString *line) {
    NSString *proc = [[NSProcessInfo processInfo] processName] ?: @"unknown";
    pid_t pid = [[NSProcessInfo processInfo] processIdentifier];
    NSLog(@"[autoinstall][%@:%d] %@", proc, pid, line);
    @try {
        NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
        formatter.dateFormat = @"yyyy-MM-dd HH:mm:ss.SSS";
        NSString *entry = [NSString stringWithFormat:@"[%@][%@:%d] %@\n", [formatter stringFromDate:[NSDate date]], proc, pid, line];
        NSData *entryData = [entry dataUsingEncoding:NSUTF8StringEncoding];

        NSArray *paths = @[
            @"/tmp/autoinstall.log",
            @"/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall.log",
            @"/private/var/mobile/Library/Caches/com.apple.PassbookUISceneService/autoinstall.log",
            @"/private/var/mobile/Library/Caches/com.apple.AuthKitUIService/autoinstall.log",
            @"/private/var/mobile/Library/Caches/com.apple.ios.StoreKitUIService/autoinstall.log",
            @"/private/var/mobile/Library/Caches/com.apple.CoreAuthUI/autoinstall.log",
            @"/private/var/mobile/Library/Caches/com.apple.AccountAuthenticationDialog/autoinstall.log"
        ];
        for (NSString *path in paths) {
            @try {
                NSString *directory = [path stringByDeletingLastPathComponent];
                [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];
                if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
                    [[NSFileManager defaultManager] createFileAtPath:path contents:nil attributes:nil];
                }
                NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
                [handle seekToEndOfFile];
                [handle writeData:entryData];
                [handle closeFile];
            } @catch (NSException *e) {}
        }
    } @catch (NSException *e) {}
}

static BOOL gIsPassbookProcess = NO;
static NSString * const kBridgeRootPath = @"/tmp/autoinstall/v1";
static NSString * const kASInstallStatusPath = @"/tmp/autoinstall-as-install-status.json";
static NSString * const kFreeAppStoreAuthorizationPath = @"/tmp/autoinstall-free-appstore-authorization.json";
static NSString * const kPaymentAuthorizationGuardDirectory = @"/tmp/autoinstall-payment-authorization";
static NSString * const kPaymentAuthorizationGuardLockPath = @"/tmp/autoinstall-payment-authorization.lock";
static NSString * const kBridgeSecretPath = @"/var/mobile/Library/Preferences/dev.adrian.autoinstall-bridge.secret";

static void writeJSONFile(NSString *path, id obj) {
    NSString *directory = [path stringByDeletingLastPathComponent];
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];
    NSError *err = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:NSJSONWritingPrettyPrinted error:&err];
    if (!data) {
        data = [[NSString stringWithFormat:@"{\"ok\":false,\"error\":\"serialize failed: %@\"}", err] dataUsingEncoding:NSUTF8StringEncoding];
    }
    [data writeToFile:path atomically:YES];
}

static void writeBridgeResponse(NSString *path, NSString *requestId, id obj) {
    if ([obj isKindOfClass:[NSDictionary class]]) {
        NSMutableDictionary *response = [obj mutableCopy];
        response[@"requestId"] = requestId;
        writeJSONFile(path, response);
        return;
    }
    writeJSONFile(path, obj);
}

static NSDictionary *readJSONFile(NSString *path) {
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) return nil;
    id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [json isKindOfClass:[NSDictionary class]] ? json : nil;
}

static void writeBridgeError(NSString *path, NSString *code, NSString *stage, NSString *message, BOOL retryable) {
    writeJSONFile(path, @{
        @"ok": @NO,
        @"error": @{
            @"code": code,
            @"stage": stage,
            @"message": message,
            @"retryable": @(retryable),
        },
    });
}

static NSString *bridgeDirectory(NSString *channel, NSString *kind) {
    return [NSString stringWithFormat:@"%@/%@/%@", kBridgeRootPath, channel, kind];
}

static NSDictionary *readJSONFile(NSString *path);

static NSString * const kAutoinstallPreferencesDomain = @"dev.adrian.autoinstall";
static NSString * const kOriginalBrightnessPath = @"/var/mobile/Library/Preferences/dev.adrian.autoinstall-original-brightness.json";
static NSString * const kRecentActivityPath = @"/var/mobile/Library/Preferences/dev.adrian.autoinstall-recent-activity.json";

static id autoinstallPreference(NSString *key) {
    return CFBridgingRelease(CFPreferencesCopyAppValue((__bridge CFStringRef)key, (__bridge CFStringRef)kAutoinstallPreferencesDomain));
}

static void setAutoinstallPreference(NSString *key, id value) {
    CFPreferencesSetAppValue((__bridge CFStringRef)key, (__bridge CFPropertyListRef)value, (__bridge CFStringRef)kAutoinstallPreferencesDomain);
    CFPreferencesAppSynchronize((__bridge CFStringRef)kAutoinstallPreferencesDomain);
}

static void appendRecentAutoinstallActivity(NSString *channel, NSString *operationId, NSString *state, NSDictionary *fields) {
    NSString *directory = [kRecentActivityPath stringByDeletingLastPathComponent];
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];
    id storedActivity = readJSONFile(kRecentActivityPath);
    NSArray *existing = [storedActivity isKindOfClass:[NSArray class]] ? (NSArray *)storedActivity : @[];
    NSMutableArray *activity = [existing mutableCopy];
    NSMutableDictionary *entry = [@{
        @"at": @([[NSDate date] timeIntervalSince1970]),
        @"channel": channel ?: @"unknown",
        @"operationId": operationId ?: @"",
        @"state": state ?: @"unknown",
    } mutableCopy];
    for (NSString *key in @[@"bundleId", @"appId", @"buildVersion", @"version", @"trainVersion"]) {
        id value = fields[key];
        if ([value isKindOfClass:[NSString class]] || [value isKindOfClass:[NSNumber class]]) entry[key] = [value description];
    }
    [activity addObject:entry];
    if (activity.count > 12) [activity removeObjectsInRange:NSMakeRange(0, activity.count - 12)];
    writeJSONFile(kRecentActivityPath, activity);
}

static NSString *bridgeTransactionPath(NSString *channel, NSString *operationId) {
    return [[bridgeDirectory(channel, @"transactions") stringByAppendingPathComponent:operationId] stringByAppendingPathExtension:@"json"];
}

static NSDictionary *readBridgeTransaction(NSString *channel, NSString *operationId) {
    return readJSONFile(bridgeTransactionPath(channel, operationId));
}

static void writeBridgeTransaction(NSString *channel, NSString *operationId, NSString *state, NSDictionary *fields) {
    NSString *directory = bridgeDirectory(channel, @"transactions");
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];
    NSMutableDictionary *transaction = [fields mutableCopy] ?: [NSMutableDictionary dictionary];
    transaction[@"operationId"] = operationId;
    transaction[@"state"] = state;
    transaction[@"updatedAt"] = @([[NSDate date] timeIntervalSince1970]);
    writeJSONFile(bridgeTransactionPath(channel, operationId), transaction);
    appendRecentAutoinstallActivity(channel, operationId, state, fields);
}

static NSDictionary *autoinstallActiveFreeAppStoreAuthorization(void) {
    NSDictionary *authorization = readJSONFile(kFreeAppStoreAuthorizationPath);
    if (!authorization && gIsPassbookProcess) {
        authorization = readJSONFile(@"/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall-free-appstore-authorization.json") ?:
                        readJSONFile(@"/private/var/mobile/Library/Caches/com.apple.PassbookUISceneService/autoinstall-free-appstore-authorization.json");
    }
    NSDictionary *status = readJSONFile(kASInstallStatusPath);
    if (!status && gIsPassbookProcess) {
        status = readJSONFile(@"/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall-as-install-status.json") ?:
                 readJSONFile(@"/private/var/mobile/Library/Caches/com.apple.PassbookUISceneService/autoinstall-as-install-status.json");
    }
    NSString *operationId = [authorization[@"operationId"] isKindOfClass:[NSString class]] ? authorization[@"operationId"] : nil;
    NSString *appName = [authorization[@"appName"] isKindOfClass:[NSString class]] ? authorization[@"appName"] : nil;
    NSArray *appNames = [authorization[@"appNames"] isKindOfClass:[NSArray class]] ? authorization[@"appNames"] : nil;
    NSNumber *verifiedPrice = [authorization[@"verifiedPrice"] isKindOfClass:[NSNumber class]] ? authorization[@"verifiedPrice"] : nil;
    NSNumber *issuedAt = [authorization[@"issuedAt"] isKindOfClass:[NSNumber class]] ? authorization[@"issuedAt"] : nil;
    if (!operationId.length || (!appName.length && !appNames.count) || !verifiedPrice || !issuedAt) return nil;
    if (status && ![status[@"operationId"] isEqual:operationId]) return nil;
    if (status && ![status[@"state"] isEqual:@"requested"] && ![status[@"state"] isEqual:@"authorizing"]) return nil;
    NSTimeInterval age = [NSDate date].timeIntervalSince1970 - issuedAt.doubleValue;
    if (age < 0 || age > 120 || verifiedPrice.doubleValue != 0) return nil;
    return authorization;
}

static void autoinstallClearFreeAppStoreAuthorization(NSString *operationId) {
    NSDictionary *authorization = readJSONFile(kFreeAppStoreAuthorizationPath) ?:
                                  readJSONFile(@"/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall-free-appstore-authorization.json");
    if (!operationId || [authorization[@"operationId"] isEqual:operationId]) {
        [[NSFileManager defaultManager] removeItemAtPath:kFreeAppStoreAuthorizationPath error:nil];
        [[NSFileManager defaultManager] removeItemAtPath:@"/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall-free-appstore-authorization.json" error:nil];
        [[NSFileManager defaultManager] removeItemAtPath:@"/private/var/mobile/Library/Caches/com.apple.PassbookUISceneService/autoinstall-free-appstore-authorization.json" error:nil];
    }
}

static void markAppStoreInstallAuthorizationPending(NSString *viewController) {
    NSDictionary *current = readJSONFile(kASInstallStatusPath);
    NSString *operationId = [current[@"operationId"] isKindOfClass:[NSString class]] ? current[@"operationId"] : nil;
    if (![current[@"state"] isEqual:@"requested"] || !operationId.length) return;
    BOOL freeInstall = autoinstallActiveFreeAppStoreAuthorization() != nil;
    NSString *state = freeInstall ? @"authorizing" : @"requires_user_action";
    NSDictionary *status = @{
        @"ok": @YES,
        @"operationId": operationId,
        @"state": state,
        @"reason": freeInstall ? @"free_install_confirmation" : @"payment_authorization_ui",
        @"viewController": viewController ?: @"unknown"
    };
    writeJSONFile(kASInstallStatusPath, status);
    writeBridgeTransaction(@"appstore", operationId, state, status);
}

static NSString *bridgeHMAC(NSString *secret, NSString *channel, NSString *requestId, NSNumber *issuedAt, NSString *payload) {
    NSString *message = [NSString stringWithFormat:@"1|%@|%@|%@|%@", channel, requestId, issuedAt, payload];
    NSData *messageData = [message dataUsingEncoding:NSUTF8StringEncoding];
    NSData *secretData = [secret dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CCHmac(kCCHmacAlgSHA256, secretData.bytes, secretData.length, messageData.bytes, messageData.length, digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", digest[index]];
    return hex;
}

static NSData *decodeBase64URL(NSString *value) {
    NSString *standard = [[value stringByReplacingOccurrencesOfString:@"-" withString:@"+"] stringByReplacingOccurrencesOfString:@"_" withString:@"/"];
    while (standard.length % 4) standard = [standard stringByAppendingString:@"="];
    return [[NSData alloc] initWithBase64EncodedString:standard options:0];
}

static NSDictionary *validatedBridgeRequest(NSDictionary *envelope, NSString *channel, NSString **requestId, NSString **error) {
    NSNumber *version = envelope[@"version"];
    NSString *candidateRequestId = envelope[@"requestId"];
    NSNumber *issuedAt = envelope[@"issuedAt"];
    NSString *payload = envelope[@"payload"];
    NSString *signature = envelope[@"signature"];
    NSString *secret = [[NSString stringWithContentsOfFile:kBridgeSecretPath encoding:NSUTF8StringEncoding error:nil] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (![version isKindOfClass:[NSNumber class]] || version.integerValue != 1 || ![[NSUUID alloc] initWithUUIDString:candidateRequestId] || ![issuedAt isKindOfClass:[NSNumber class]] || ![payload isKindOfClass:[NSString class]] || ![signature isKindOfClass:[NSString class]] || secret.length < 32) {
        *error = @"invalid authenticated bridge envelope";
        return nil;
    }
    if (fabs([[NSDate date] timeIntervalSince1970] - issuedAt.doubleValue) > 120) {
        *error = @"authenticated bridge envelope expired";
        return nil;
    }
    if (![bridgeHMAC(secret, channel, candidateRequestId, issuedAt, payload) isEqualToString:signature]) {
        *error = @"authenticated bridge envelope signature did not match";
        return nil;
    }
    NSData *payloadData = decodeBase64URL(payload);
    id decoded = payloadData ? [NSJSONSerialization JSONObjectWithData:payloadData options:0 error:nil] : nil;
    if (![decoded isKindOfClass:[NSDictionary class]]) {
        *error = @"authenticated bridge payload was not an object";
        return nil;
    }
    NSMutableDictionary *request = [decoded mutableCopy];
    request[@"requestId"] = candidateRequestId;
    *requestId = candidateRequestId;
    return request;
}

static void writeBridgeHeartbeat(NSString *channel) {
    static NSMutableDictionary<NSString *, NSNumber *> *lastWritten = nil;
    if (!lastWritten) lastWritten = [NSMutableDictionary dictionary];
    NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
    if (now - lastWritten[channel].doubleValue < 30) return;
    NSString *directory = bridgeDirectory(channel, @"state");
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];
    writeJSONFile([directory stringByAppendingPathComponent:@"heartbeat.json"], @{
        @"bridgeVersion": BRIDGE_VERSION,
        @"channel": channel,
        @"process": [[NSProcessInfo processInfo] processName],
        @"at": @(now),
    });
    lastWritten[channel] = @(now);
}

static void sweepBridgeArtifacts(NSString *channel) {
    static NSMutableDictionary<NSString *, NSNumber *> *lastSwept = nil;
    if (!lastSwept) lastSwept = [NSMutableDictionary dictionary];
    NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
    if (now - lastSwept[channel].doubleValue < 30) return;
    lastSwept[channel] = @(now);
    NSFileManager *fm = [NSFileManager defaultManager];
    NSDate *cutoff = [NSDate dateWithTimeIntervalSinceNow:-1800];
    for (NSString *kind in @[@"requests", @"responses", @"transactions"]) {
        NSString *directory = bridgeDirectory(channel, kind);
        [fm createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];
        for (NSString *name in [fm contentsOfDirectoryAtPath:directory error:nil] ?: @[]) {
            NSString *file = [directory stringByAppendingPathComponent:name];
            NSDate *modified = [fm attributesOfItemAtPath:file error:nil][NSFileModificationDate];
            if ([modified compare:cutoff] == NSOrderedAscending && [fm removeItemAtPath:file error:nil]) {
                autoinstallLog([NSString stringWithFormat:@"%@-bridge: removed stale artifact %@", channel, name]);
            }
        }
    }
}

static void processSecureBridgeRequests(NSString *channel, void (^handler)(NSDictionary *request, NSString *responsePath, NSString *requestId)) {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *requests = bridgeDirectory(channel, @"requests");
    NSString *responses = bridgeDirectory(channel, @"responses");
    [fm createDirectoryAtPath:requests withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];
    [fm createDirectoryAtPath:responses withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];
    for (NSString *name in [[fm contentsOfDirectoryAtPath:requests error:nil] sortedArrayUsingSelector:@selector(compare:)] ?: @[]) {
        if (![name hasSuffix:@".json"]) continue;
        NSString *requestPath = [requests stringByAppendingPathComponent:name];
        NSData *data = [NSData dataWithContentsOfFile:requestPath];
        [fm removeItemAtPath:requestPath error:nil];
        id envelope = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        NSString *candidateRequestId = [envelope isKindOfClass:[NSDictionary class]] && [envelope[@"requestId"] isKindOfClass:[NSString class]] ? envelope[@"requestId"] : nil;
        NSString *requestId = nil;
        NSString *error = nil;
        NSDictionary *request = [envelope isKindOfClass:[NSDictionary class]] ? validatedBridgeRequest(envelope, channel, &requestId, &error) : nil;
        NSString *responseId = requestId ?: candidateRequestId;
        NSString *responsePath = responseId.length ? [responses stringByAppendingPathComponent:[NSString stringWithFormat:@"%@.response.json", responseId]] : nil;
        if (!request) {
            if (responsePath) {
                writeBridgeResponse(responsePath, responseId, @{@"ok": @NO, @"error": error ?: @"invalid authenticated bridge request"});
            }
            continue;
        }
        handler(request, responsePath, requestId);
    }
}

static void rejectLegacyBridgeRequest(NSDictionary *request, NSString *responsePath) {
    writeBridgeError(responsePath, @"protocol_upgrade_required", @"authentication", @"use the authenticated autoinstall bridge protocol", NO);
}

@interface AutoinstallPrecheckDelegate : NSObject <TFInstallAlertDelegate>
@end

@implementation AutoinstallPrecheckDelegate

- (BOOL)presentPrecheckAlertWithType:(NSInteger)type installable:(id)installable completion:(void (^)(BOOL))completion {
    autoinstallLog([NSString stringWithFormat:@"install: approving precheck alert type=%ld installable=%@", (long)type, installable]);
    completion(YES);
    return YES;
}

- (void)dismissPrecheckAlert {}

@end

static BOOL autoinstallHandlePasswordIfPresent(void);
static NSArray *autoinstallConfirmMatching(NSString *match);
static BOOL autoinstallValidTestFlightInvite(NSString *urlString);
static void autoinstallScheduleInviteControls(NSUInteger attempt);

static NSString * const kAutoConfirmFlagPath = @"/tmp/autoinstall-autoconfirm.flag";
static NSTimeInterval const kAutoConfirmLifetimeSeconds = 360.0;

static NSArray *autoinstallAutoConfirmFlagPaths(void) {
    return @[
        kAutoConfirmFlagPath,
        @"/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall-autoconfirm.flag",
        @"/private/var/mobile/Library/Caches/com.apple.PassbookUISceneService/autoinstall-autoconfirm.flag",
        @"/private/var/mobile/Library/Caches/com.apple.AuthKitUIService/autoinstall-autoconfirm.flag",
        @"/private/var/mobile/Library/Caches/com.apple.ios.StoreKitUIService/autoinstall-autoconfirm.flag",
        @"/private/var/mobile/Library/Caches/com.apple.CoreAuthUI/autoinstall-autoconfirm.flag",
        @"/private/var/mobile/Library/Caches/com.apple.AccountAuthenticationDialog/autoinstall-autoconfirm.flag"
    ];
}

static void autoinstallClearAutoConfirmFlags(void) {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    for (NSString *path in autoinstallAutoConfirmFlagPaths()) [fileManager removeItemAtPath:path error:nil];
}

static NSString *autoinstallAutoConfirmMatchAtPath(NSString *path) {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    if (![fileManager fileExistsAtPath:path]) return nil;
    NSString *contents = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
    NSString *trimmed = [contents stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (!trimmed.length) {
        autoinstallClearAutoConfirmFlags();
        return nil;
    }

    NSArray *lines = [trimmed componentsSeparatedByString:@"\n"];
    NSString *header = lines.firstObject ?: @"";
    NSString *match = trimmed;
    if ([header hasPrefix:@"expiresAtMs="]) {
        NSString *expiryValue = [header substringFromIndex:[@"expiresAtMs=" length]];
        NSScanner *scanner = [NSScanner scannerWithString:expiryValue];
        long long expiryMs = 0;
        if (![scanner scanLongLong:&expiryMs] || !scanner.isAtEnd || expiryMs <= (long long)(NSDate.date.timeIntervalSince1970 * 1000.0)) {
            autoinstallClearAutoConfirmFlags();
            return nil;
        }
        match = lines.count > 1 ? [[lines subarrayWithRange:NSMakeRange(1, lines.count - 1)] componentsJoinedByString:@"\n"] : @"";
    } else {
        NSDictionary *attributes = [fileManager attributesOfItemAtPath:path error:nil];
        NSDate *modifiedAt = attributes[NSFileModificationDate];
        if (!modifiedAt || -modifiedAt.timeIntervalSinceNow > kAutoConfirmLifetimeSeconds) {
            autoinstallClearAutoConfirmFlags();
            return nil;
        }
    }

    match = [match stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    return match.length ? match : @"Install";
}

static NSString *autoinstallSyncAutoConfirmFlag(void) {
    NSString *match = autoinstallAutoConfirmMatchAtPath(kAutoConfirmFlagPath);
    if (!match) return nil;
    NSString *contents = [NSString stringWithContentsOfFile:kAutoConfirmFlagPath encoding:NSUTF8StringEncoding error:nil];
    NSArray *paths = autoinstallAutoConfirmFlagPaths();
    NSFileManager *fileManager = [NSFileManager defaultManager];
    for (NSUInteger index = 1; index < paths.count; index++) {
        NSString *path = paths[index];
        [fileManager createDirectoryAtPath:[path stringByDeletingLastPathComponent] withIntermediateDirectories:YES attributes:nil error:nil];
        NSString *existing = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
        if (![existing isEqualToString:contents]) [contents writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
    }
    return match;
}

static BOOL isSpringBoard(void) {
    return [[[NSBundle mainBundle] bundleIdentifier] isEqualToString:@"com.apple.springboard"];
}

#pragma mark - SpringBoard side: SSH-toggleable dark-but-awake state + launch-on-demand

static NSString * const kDarkFlagPath = @"/var/mobile/Library/Preferences/dev.adrian.autoinstall-dark.flag";
static NSString * const kSBRequestPath = @"/tmp/autoinstall-sb-request.json";
static NSString * const kSBResponsePath = @"/tmp/autoinstall-sb-response.json";

typedef int (*SBSLaunchFn)(CFStringRef, unsigned char);

static int sbsLaunchApplication(NSString *bundleId) {
    if ([bundleId isEqualToString:@"com.apple.AppStore"]) {
        char *const itmsArgs[] = {(char *)"/var/jb/usr/bin/uiopen", (char *)"--url", (char *)"itms-apps://", NULL};
        runSpawnAsync("/var/jb/usr/bin/uiopen", itmsArgs);
    }
    char *const args[] = {(char *)"/var/jb/usr/bin/uiopen", (char *)"--bundleid", (char *)bundleId.UTF8String, NULL};
    runSpawnAsync("/var/jb/usr/bin/uiopen", args);
    void *sbs = dlopen("/System/Library/PrivateFrameworks/SpringBoardServices.framework/SpringBoardServices", RTLD_NOW);
    if (sbs) {
        SBSLaunchFn fn = (SBSLaunchFn)dlsym(sbs, "SBSLaunchApplicationWithIdentifier");
        if (fn) fn((__bridge CFStringRef)bundleId, 0);
    }
    return 0;
}

static id getIvarObject(id instance, const char *ivarName) {
    if (!instance) return nil;
    Ivar ivar = class_getInstanceVariable([instance class], ivarName);
    if (!ivar) return nil;
    return object_getIvar(instance, ivar);
}

static BOOL respondsToSelectorSafe(id object, SEL selector) {
    return object != nil && [object respondsToSelector:selector];
}

static id<SBBacklightControllerProtocol> backlightController(void) {
    Class<SBBacklightControllerProtocol> backlightCls = (Class<SBBacklightControllerProtocol>)objc_getClass("SBBacklightController");
    if (!respondsToSelectorSafe((id)backlightCls, @selector(sharedInstance))) return nil;
    return [backlightCls sharedInstance];
}

static id<BrightnessSystemClientProtocol> brightnessClient(void) {
    id backlight = backlightController();
    return getIvarObject(backlight, "_brightnessSystemClient");
}

static BOOL setBrightnessFactor(NSNumber *factor) {
    id<BrightnessSystemClientProtocol> bsc = brightnessClient();
    if (!bsc) {
        autoinstallLog(@"setBrightnessFactor: _brightnessSystemClient not found");
        return NO;
    }
    if (!respondsToSelectorSafe(bsc, @selector(setProperty:forKey:))) {
        autoinstallLog(@"setBrightnessFactor: setProperty:forKey: unavailable");
        return NO;
    }
    BOOL result = [bsc setProperty:factor forKey:@"DisplayBrightnessFactor"];
    autoinstallLog([NSString stringWithFormat:@"setBrightnessFactor: DisplayBrightnessFactor=%@ result=%d", factor, result]);
    return result;
}

static NSNumber *currentBrightnessFactor(void) {
    id value = [brightnessClient() copyPropertyForKey:@"DisplayBrightnessFactor"];
    if ([value isKindOfClass:[NSNumber class]]) return value;
    if ([value isKindOfClass:[NSString class]]) {
        double factor = [(NSString *)value doubleValue];
        return isfinite(factor) && factor >= 0.0 && factor <= 1.0 ? @(factor) : nil;
    }
    return nil;
}

static void saveOriginalBrightnessIfNeeded(void) {
    NSFileManager *fm = [NSFileManager defaultManager];
    if ([fm fileExistsAtPath:kOriginalBrightnessPath]) return;
    NSNumber *factor = currentBrightnessFactor();
    if ([fm fileExistsAtPath:kDarkFlagPath] && factor.doubleValue <= 0.001) return;
    if (factor) writeJSONFile(kOriginalBrightnessPath, @{@"factor": factor});
}

static BOOL restoreOriginalBrightness(BOOL useLegacyFallback) {
    NSDictionary *saved = readJSONFile(kOriginalBrightnessPath);
    NSNumber *factor = [saved[@"factor"] isKindOfClass:[NSNumber class]] ? saved[@"factor"] : nil;
    BOOL legacyDarkState = [[NSFileManager defaultManager] fileExistsAtPath:kDarkFlagPath] && currentBrightnessFactor().doubleValue <= 0.001;
    if (!factor && (useLegacyFallback || legacyDarkState)) factor = @1.0;
    BOOL result = factor ? setBrightnessFactor(factor) : YES;
    id backlight = backlightController();
    if (respondsToSelectorSafe(backlight, @selector(allowIdleSleep))) [backlight allowIdleSleep];
    if (factor) [[NSFileManager defaultManager] removeItemAtPath:kOriginalBrightnessPath error:nil];
    if (legacyDarkState) [[NSFileManager defaultManager] removeItemAtPath:kDarkFlagPath error:nil];
    return result;
}

static BOOL applyDark(void) {
    @try {
        saveOriginalBrightnessIfNeeded();
        id backlight = backlightController();
        if (respondsToSelectorSafe(backlight, @selector(preventIdleSleep))) {
            [backlight preventIdleSleep];
        } else {
            autoinstallLog(@"applyDark: preventIdleSleep unavailable");
        }
        BOOL result = setBrightnessFactor(@(0));
        autoinstallLog([NSString stringWithFormat:@"applyDark: DisplayBrightnessFactor=0 result=%d", result]);
        return result;
    } @catch (NSException *exception) {
        autoinstallLog([NSString stringWithFormat:@"applyDark: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
        return NO;
    }
}

static BOOL removeDark(void) {
    @try {
        BOOL result = restoreOriginalBrightness(YES);
        autoinstallLog([NSString stringWithFormat:@"removeDark: restored saved display brightness result=%d", result]);
        return result;
    } @catch (NSException *exception) {
        autoinstallLog([NSString stringWithFormat:@"removeDark: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
        return NO;
    }
}

static BOOL isDarkFlagSet(void) {
    return [[NSFileManager defaultManager] fileExistsAtPath:kDarkFlagPath];
}

static NSString *autoinstallDisplayMode(void) {
    id mode = autoinstallPreference(@"DisplayMode");
    if ([mode isKindOfClass:[NSString class]] && [@[@"dark_awake", @"dark_sleep", @"restore_idle", @"unchanged"] containsObject:mode]) return mode;
    return isDarkFlagSet() ? @"dark_awake" : @"unchanged";
}

static NSDictionary *activeInstallOperation(void) {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSTimeInterval now = [NSDate date].timeIntervalSince1970;
    NSDictionary *latest;
    for (NSString *channel in @[@"appstore", @"testflight"]) {
        NSString *directory = bridgeDirectory(channel, @"transactions");
        for (NSString *name in [fm contentsOfDirectoryAtPath:directory error:nil] ?: @[]) {
            if (![name.pathExtension isEqualToString:@"json"]) continue;
            NSDictionary *transaction = readJSONFile([directory stringByAppendingPathComponent:name]);
            NSString *state = transaction[@"state"];
            NSTimeInterval updatedAt = [transaction[@"updatedAt"] respondsToSelector:@selector(doubleValue)] ? [transaction[@"updatedAt"] doubleValue] : 0;
            if (![state isEqual:@"requested"] && ![state isEqual:@"authorizing"] && ![state isEqual:@"installing"]) continue;
            if (updatedAt <= 0 || now - updatedAt > 1800) continue;
            if (!latest || updatedAt > [latest[@"updatedAt"] doubleValue]) latest = transaction;
        }
    }
    return latest;
}

static NSDictionary *autoinstallBatteryStatus(void) {
    UIDevice *device = [UIDevice currentDevice];
    device.batteryMonitoringEnabled = YES;
    float level = device.batteryLevel;
    UIDeviceBatteryState state = device.batteryState;
    return @{
        @"batteryPercent": level >= 0.0f ? @((NSInteger)roundf(level * 100.0f)) : [NSNull null],
        @"batteryCharging": @(state == UIDeviceBatteryStateCharging || state == UIDeviceBatteryStateFull),
    };
}

static NSDictionary *autoinstallPauseStatus(void) {
    if ([autoinstallPreference(@"Paused") boolValue]) return @{@"paused": @YES, @"reason": @"Paused on iPad"};
    NSDictionary *battery = autoinstallBatteryStatus();
    NSNumber *percent = [battery[@"batteryPercent"] isKindOfClass:[NSNumber class]] ? battery[@"batteryPercent"] : nil;
    NSInteger threshold = [autoinstallPreference(@"LowBatteryThreshold") respondsToSelector:@selector(integerValue)] ? [autoinstallPreference(@"LowBatteryThreshold") integerValue] : 20;
    BOOL pauseOnLowBattery = [autoinstallPreference(@"PauseOnLowBattery") boolValue];
    BOOL charging = [battery[@"batteryCharging"] boolValue];
    if (pauseOnLowBattery && percent && percent.integerValue < threshold && !charging) {
        return @{@"paused": @YES, @"reason": [NSString stringWithFormat:@"Waiting for charge · battery is %@%%", percent]};
    }
    return @{@"paused": @NO, @"reason": [NSNull null]};
}

static BOOL applyDarkWithoutKeepingAwake(void) {
    @try {
        saveOriginalBrightnessIfNeeded();
        BOOL result = setBrightnessFactor(@0);
        id backlight = backlightController();
        if (respondsToSelectorSafe(backlight, @selector(allowIdleSleep))) [backlight allowIdleSleep];
        return result;
    } @catch (NSException *exception) {
        autoinstallLog([NSString stringWithFormat:@"applyDarkWithoutKeepingAwake: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
        return NO;
    }
}

static NSString *gAppliedDisplayState = nil;

static BOOL applyConfiguredDisplayMode(void) {
    NSString *mode = autoinstallDisplayMode();
    NSDictionary *operation = activeInstallOperation();
    BOOL operationActive = operation != nil;
    NSString *state = [NSString stringWithFormat:@"%@:%@", mode, operationActive ? @"active" : @"idle"];
    if ([state isEqualToString:gAppliedDisplayState]) return YES;
    BOOL applied = YES;
    if ([mode isEqual:@"dark_awake"]) applied = applyDark();
    else if ([mode isEqual:@"dark_sleep"]) applied = applyDarkWithoutKeepingAwake();
    else if ([mode isEqual:@"restore_idle"] && operationActive) applied = applyDark();
    else applied = restoreOriginalBrightness(NO);
    if (applied) gAppliedDisplayState = state;
    return applied;
}

static void setDarkFlag(BOOL on) {
    NSFileManager *fm = [NSFileManager defaultManager];
    if (on) {
        [fm createFileAtPath:kDarkFlagPath contents:[NSData data] attributes:nil];
    } else {
        [fm removeItemAtPath:kDarkFlagPath error:nil];
    }
}

static NSDictionary *screenStatusDict(void) {
    id backlight = backlightController();
    id bsc = brightnessClient();
    NSString *displayMode = autoinstallDisplayMode();
    NSDictionary *operation = activeInstallOperation();
    NSDictionary *pause = autoinstallPauseStatus();
    NSDictionary *battery = autoinstallBatteryStatus();
    BOOL displayIsDark = ([displayMode isEqual:@"dark_awake"] || [displayMode isEqual:@"dark_sleep"] || ([displayMode isEqual:@"restore_idle"] && operation != nil));
    NSMutableDictionary *status = [@{
        @"ok": @YES,
        @"darkEnabled": @(displayIsDark),
        @"displayMode": displayMode,
        @"autoinstallPaused": pause[@"paused"],
        @"pauseReason": pause[@"reason"],
        @"batteryPauseEnabled": @([autoinstallPreference(@"PauseOnLowBattery") boolValue]),
        @"batteryPauseThreshold": autoinstallPreference(@"LowBatteryThreshold") ?: @20,
        @"batteryPercent": battery[@"batteryPercent"],
        @"batteryCharging": battery[@"batteryCharging"],
        @"activeOperation": operation ? operation[@"bundleId"] ?: operation[@"channel"] : [NSNull null],
    } mutableCopy];
    if (respondsToSelectorSafe(backlight, @selector(screenIsOn))) {
        status[@"screenIsOn"] = @([backlight screenIsOn]);
    }
    if (respondsToSelectorSafe(backlight, @selector(screenIsDim))) {
        status[@"screenIsDim"] = @([backlight screenIsDim]);
    }
    if (respondsToSelectorSafe(backlight, @selector(backlightState))) {
        status[@"backlightState"] = @([backlight backlightState]);
    }
    if (respondsToSelectorSafe(bsc, @selector(copyPropertyForKey:))) {
        id factor = [bsc copyPropertyForKey:@"DisplayBrightnessFactor"];
        status[@"brightnessFactor"] = factor ? [factor description] : [NSNull null];
    } else {
        status[@"brightnessFactor"] = [NSNull null];
    }
    return status;
}

static NSDictionary *springBoardBridgeStatus(void) {
    NSMutableDictionary *status = [screenStatusDict() mutableCopy];
    status[@"bridgeVersion"] = BRIDGE_VERSION;
    status[@"capabilities"] = @[@"dark_on", @"dark_off", @"launch_app", @"screen_status", @"status", @"device_preferences", @"local_pause", @"low_battery_pause", @"recent_activity", @"protocol_v1", @"authenticated_requests", @"operation_responses", @"heartbeats", @"stale_artifact_cleanup"];
    return status;
}

static void unlockDeviceIfLocked(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            Class lsmCls = objc_getClass("SBLockScreenManager");
            if (lsmCls && [lsmCls respondsToSelector:sel_registerName("sharedInstance")]) {
                id lsm = ((id (*)(id, SEL))objc_msgSend)(lsmCls, sel_registerName("sharedInstance"));
                SEL unlockSel = sel_registerName("unlockUIFromSource:withOptions:");
                if (lsm && [lsm respondsToSelector:unlockSel]) {
                    ((void (*)(id, SEL, int, id))objc_msgSend)(lsm, unlockSel, 0, nil);
                    autoinstallLog(@"unlocked UI via SBLockScreenManager");
                }
            }
        } @catch (NSException *e) {
            autoinstallLog([NSString stringWithFormat:@"unlockDeviceIfLocked exception: %@", e]);
        }
    });
}

static void handleSpringBoardRequest(NSDictionary *req, NSString *responsePath, NSString *requestId) {
    NSString *action = req[@"action"];
    autoinstallLog([NSString stringWithFormat:@"sb-bridge: handling action=%@ req=%@", action, req]);

    @try {
        if ([action isEqualToString:@"dark_on"]) {
            setAutoinstallPreference(@"DisplayMode", @"dark_awake");
            setDarkFlag(YES);
            gAppliedDisplayState = nil;
            BOOL applied = applyConfiguredDisplayMode();
            NSMutableDictionary *status = [screenStatusDict() mutableCopy];
            status[@"ok"] = @(applied);
            if (!applied) status[@"error"] = @"dark mode could not be applied";
            writeBridgeResponse(responsePath, requestId, status);
            return;
        }

        if ([action isEqualToString:@"dark_off"]) {
            setAutoinstallPreference(@"DisplayMode", @"unchanged");
            setDarkFlag(NO);
            gAppliedDisplayState = nil;
            BOOL removed = removeDark();
            NSMutableDictionary *status = [screenStatusDict() mutableCopy];
            status[@"ok"] = @(removed);
            if (!removed) status[@"error"] = @"dark mode could not be disabled";
            writeBridgeResponse(responsePath, requestId, status);
            return;
        }

        if ([action isEqualToString:@"launch_app"]) {
            NSString *bundleId = req[@"bundleId"];
            if (!bundleId) {
                writeBridgeResponse(responsePath, requestId, @{@"ok": @NO, @"error": @"missing bundleId"});
                return;
            }
            unlockDeviceIfLocked();
            applyConfiguredDisplayMode();
            int rc = sbsLaunchApplication(bundleId);
            autoinstallLog([NSString stringWithFormat:@"launch_app: SBSLaunchApplicationWithIdentifier(%@)=%d", bundleId, rc]);
            NSMutableDictionary *resp = [screenStatusDict() mutableCopy];
            resp[@"ok"] = rc == 0 ? @YES : @NO;
            resp[@"launchResult"] = @(rc);
            writeBridgeResponse(responsePath, requestId, resp);
            return;
        }

        if ([action isEqualToString:@"screen_status"] || [action isEqualToString:@"status"]) {
            writeBridgeResponse(responsePath, requestId, springBoardBridgeStatus());
            return;
        }

        writeBridgeResponse(responsePath, requestId, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"unknown action: %@", action]});
    } @catch (NSException *exception) {
        autoinstallLog([NSString stringWithFormat:@"sb-bridge: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
        writeBridgeResponse(responsePath, requestId, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason]});
    }
}

static dispatch_queue_t gSBBridgeQueue = nil;
static dispatch_source_t gSBBridgeTimer = nil;

static void startSpringBoardSide(void) {
    gSBBridgeQueue = dispatch_queue_create("dev.adrian.autoinstall.sb-bridge", DISPATCH_QUEUE_SERIAL);
    gSBBridgeTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gSBBridgeQueue);
    dispatch_source_set_timer(gSBBridgeTimer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_MSEC * 200);
    dispatch_source_set_event_handler(gSBBridgeTimer, ^{
        @autoreleasepool {
        NSFileManager *fm = [NSFileManager defaultManager];
        applyConfiguredDisplayMode();
        writeBridgeHeartbeat(@"springboard");
        sweepBridgeArtifacts(@"springboard");
        processSecureBridgeRequests(@"springboard", ^(NSDictionary *request, NSString *responsePath, NSString *requestId) {
            handleSpringBoardRequest(request, responsePath, requestId);
        });

        NSArray *syncDirs = @[
            @"/private/var/mobile/Library/Caches/com.apple.PassbookUIService",
            @"/private/var/mobile/Library/Caches/com.apple.AuthKitUIService",
            @"/private/var/mobile/Library/Caches/com.apple.ios.StoreKitUIService"
        ];
        NSString *prefPw = @"/var/mobile/Library/Preferences/dev.adrian.autoinstall-password.txt";
        NSString *srcPw = nil;
        if ([fm fileExistsAtPath:@"/tmp/autoinstall-password.txt"]) {
            srcPw = @"/tmp/autoinstall-password.txt";
            if (![fm fileExistsAtPath:prefPw]) {
                [fm copyItemAtPath:srcPw toPath:prefPw error:nil];
            }
        } else if ([fm fileExistsAtPath:prefPw]) {
            srcPw = prefPw;
        }

        if (srcPw) {
            for (NSString *dir in syncDirs) {
                [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
                NSString *dst = [dir stringByAppendingPathComponent:@"autoinstall-password.txt"];
                if (![fm fileExistsAtPath:dst]) {
                    [fm copyItemAtPath:srcPw toPath:dst error:nil];
                }
            }
        }

        autoinstallSyncAutoConfirmFlag();

        dispatch_async(dispatch_get_main_queue(), ^{
            autoinstallHandlePasswordIfPresent();
            NSString *match = autoinstallAutoConfirmMatchAtPath(kAutoConfirmFlagPath);
            if (!match) return;
            NSArray *acted = autoinstallConfirmMatching(match);
            if (acted.count > 0) autoinstallClearAutoConfirmFlags();
        });

        if (![fm fileExistsAtPath:kSBRequestPath]) return;

        NSData *data = [NSData dataWithContentsOfFile:kSBRequestPath];
        [fm removeItemAtPath:kSBRequestPath error:nil];
        if (!data) return;

        NSError *err = nil;
        NSDictionary *req = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
        if (!req) {
            autoinstallLog([NSString stringWithFormat:@"sb-bridge: bad request json: %@", err]);
            return;
        }
        rejectLegacyBridgeRequest(req, kSBResponsePath);
        }
    });
    dispatch_resume(gSBBridgeTimer);
    autoinstallLog(@"sb-bridge: request-file watcher started");

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * NSEC_PER_SEC)), gSBBridgeQueue, ^{
        gAppliedDisplayState = nil;
        applyConfiguredDisplayMode();
    });
}

#pragma mark - TestFlight side: list / install bridge

static id gInstaller = nil;
static id gCatalogManager = nil;
static UIBackgroundTaskIdentifier gBackgroundTaskId = 0;
static AutoinstallPrecheckDelegate *gPrecheckDelegate = nil;

static void beginBackgroundKeepAlive(void) {
    if (gBackgroundTaskId != UIBackgroundTaskInvalid) return;
    gBackgroundTaskId = [[UIApplication sharedApplication] beginBackgroundTaskWithName:@"autoinstall-install" expirationHandler:^{
        autoinstallLog([NSString stringWithFormat:@"background task %lu expired", (unsigned long)gBackgroundTaskId]);
        [[UIApplication sharedApplication] endBackgroundTask:gBackgroundTaskId];
        gBackgroundTaskId = UIBackgroundTaskInvalid;
    }];
    autoinstallLog([NSString stringWithFormat:@"began background task id=%lu remaining=%f", (unsigned long)gBackgroundTaskId,
        [[UIApplication sharedApplication] backgroundTimeRemaining]]);
}

static void endBackgroundKeepAlive(void) {
    if (gBackgroundTaskId == UIBackgroundTaskInvalid) return;
    autoinstallLog([NSString stringWithFormat:@"ending background task id=%lu", (unsigned long)gBackgroundTaskId]);
    [[UIApplication sharedApplication] endBackgroundTask:gBackgroundTaskId];
    gBackgroundTaskId = UIBackgroundTaskInvalid;
}

%hook TFAppCatalogManager

- (id)initWithNetworkManager:(id)networkManager nanoDeviceConnection:(id)nanoDeviceConnection {
    id result = %orig;
    gCatalogManager = result;
    return result;
}

- (id)initWithAppCatalog:(id)appCatalog networkManager:(id)networkManager nanoDeviceConnection:(id)nanoDeviceConnection {
    id result = %orig;
    gCatalogManager = result;
    return result;
}

%end

%hook TFAppInstaller

+ (id)installerWithInstallManager:(id)installManager nanoInstallManager:(id)nanoInstallManager {
    id result = %orig;
    gInstaller = result;
    return result;
}

- (id)initWithInstallManager:(id)installManager nanoInstallManager:(id)nanoInstallManager {
    id result = %orig;
    gInstaller = result;
    return result;
}

%end

static NSString * const kRequestPath = @"/tmp/autoinstall-request.json";
static NSString * const kResponsePath = @"/tmp/autoinstall-response.json";
static NSString * const kInstallStatusPath = @"/tmp/autoinstall-install-status.json";

static NSDictionary *bridgeStatus(void) {
    return @{
        @"bridgeVersion": BRIDGE_VERSION,
        @"capabilities": @[@"list_trains", @"list_builds", @"list_apps", @"device_catalog", @"install", @"status", @"diagnostics", @"subscribe_invite", @"status_invite", @"unsubscribe_invite", @"invite_lifecycle", @"idempotent_install", @"protocol_v1", @"authenticated_requests", @"operation_responses", @"heartbeats", @"stale_artifact_cleanup"],
        @"hasInstaller": gInstaller ? @YES : @NO,
        @"hasCatalogManager": gCatalogManager ? @YES : @NO,
        @"backgroundTaskActive": gBackgroundTaskId != UIBackgroundTaskInvalid ? @YES : @NO,
        @"backgroundTimeRemaining": @([[UIApplication sharedApplication] backgroundTimeRemaining]),
    };
}

static NSArray<NSString *> *recentBridgeLogEntries(void) {
    NSString *log = [NSString stringWithContentsOfFile:@"/tmp/autoinstall.log" encoding:NSUTF8StringEncoding error:nil];
    if (!log.length) return @[];
    NSArray<NSString *> *lines = [log componentsSeparatedByCharactersInSet:[NSCharacterSet newlineCharacterSet]];
    NSUInteger start = lines.count > 20 ? lines.count - 20 : 0;
    NSMutableArray<NSString *> *recent = [NSMutableArray array];
    for (NSUInteger index = start; index < lines.count; index++) {
        NSString *line = lines[index];
        if (line.length) [recent addObject:line];
    }
    return recent;
}

static NSString *networkErrorDescription(id error) {
    if ([error respondsToSelector:@selector(localizedDescription)]) {
        return [error localizedDescription];
    }
    return [NSString stringWithFormat:@"%@", error];
}

static void fetchJSON(NSString *urlString, void (^completion)(id json, NSDictionary *error)) {
    NSURL *url = [NSURL URLWithString:urlString];
    Class<TFNetworkManagerProtocol> cls = (Class<TFNetworkManagerProtocol>)objc_getClass("TFNetworkManager");
    id<TFNetworkManagerProtocol> manager = [cls shared];

    [manager enqueueDataTaskWithURL:url completionHandler:^(id response) {
        @try {
            id<TFNetworkManagerResponseProtocol> typedResponse = response;
            NSError *error = [typedResponse error];
            id data = [typedResponse data];
            if (error) {
                completion(nil, @{
                    @"code": @"network_request_failed",
                    @"stage": @"metadata_fetch",
                    @"message": networkErrorDescription(error),
                    @"retryable": @YES,
                });
                return;
            }
            if (!data) {
                completion(nil, @{
                    @"code": @"missing_response_data",
                    @"stage": @"metadata_fetch",
                    @"message": @"no data in response",
                    @"retryable": @YES,
                });
                return;
            }
            completion(data, nil);
        } @catch (NSException *exception) {
            autoinstallLog([NSString stringWithFormat:@"fetchJSON: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
            completion(nil, @{
                @"code": @"metadata_exception",
                @"stage": @"metadata_fetch",
                @"message": [NSString stringWithFormat:@"exception: %@", exception.reason],
                @"retryable": @YES,
            });
        }
    }];
}

static BOOL autoinstallValidTestFlightInvite(NSString *urlString) {
    NSURL *url = [NSURL URLWithString:urlString];
    if (!url || ![url.scheme.lowercaseString isEqualToString:@"https"] || ![url.host.lowercaseString isEqualToString:@"testflight.apple.com"] || url.port || url.user || url.password || url.query.length || url.fragment.length) return NO;
    NSArray<NSString *> *parts = [url.path componentsSeparatedByString:@"/"];
    if (parts.count != 3 || ![parts[1] isEqualToString:@"join"] || parts[2].length < 4 || parts[2].length > 32) return NO;
    NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
    return [parts[2] rangeOfCharacterFromSet:[allowed invertedSet]].location == NSNotFound;
}

static NSString *autoinstallTestFlightDeepLink(NSString *urlString) {
    NSURL *url = [NSURL URLWithString:urlString];
    if (!url) return nil;
    return [NSString stringWithFormat:@"itms-beta://%@%@", url.host, url.path];
}

static void handleRequest(NSDictionary *req, NSString *responsePath, NSString *requestId) {
    void (^respond)(id) = ^(id response) { writeBridgeResponse(responsePath, requestId, response); };
    void (^fail)(NSString *, NSString *, NSString *, BOOL) = ^(NSString *code, NSString *stage, NSString *message, BOOL retryable) {
        respond(@{@"ok": @NO, @"error": @{@"code": code, @"stage": stage, @"message": message, @"retryable": @(retryable)}});
    };
    NSString *action = req[@"action"];
    autoinstallLog([NSString stringWithFormat:@"bridge: handling action=%@ req=%@", action, req]);

    if ([action isEqualToString:@"subscribe_invite"]) {
        @try {
            NSString *url = [req[@"url"] isKindOfClass:[NSString class]] ? req[@"url"] : @"";
            if (!autoinstallValidTestFlightInvite(url)) {
                fail(@"invalid_request", @"subscribe_invite", @"only canonical testflight.apple.com public links are supported", NO);
                return;
            }
            NSNumber *appId = [req[@"appId"] isKindOfClass:[NSNumber class]] ? req[@"appId"] : nil;
            if (appId && appId.longLongValue > 0 && gCatalogManager) {
                id existingApp = [(id<TFAppCatalogManagerProtocol>)gCatalogManager getAppCatalogCachedAppForAppID:appId];
                if (existingApp) {
                    respond(@{ @"ok": @YES, @"requested": @NO, @"alreadySubscribed": @YES, @"appleMembership": @"accepted" });
                    return;
                }
            }
            NSString *operationId = [req[@"operationId"] isKindOfClass:[NSString class]] ? req[@"operationId"] : [[NSUUID UUID] UUIDString];
            NSDictionary *previous = readBridgeTransaction(@"testflight", operationId);
            if ([previous[@"operationId"] isEqual:operationId] && ![previous[@"state"] isEqualToString:@"failed"]) {
                respond(@{ @"ok": @YES, @"requested": @NO, @"resumed": @YES, @"operationId": operationId, @"appleMembership": @"pending" });
                return;
            }
            void (^failInvite)(NSString *, NSString *, NSString *, BOOL) = ^(NSString *code, NSString *stage, NSString *message, BOOL retryable) {
                writeBridgeTransaction(@"testflight", operationId, @"failed", @{ @"ok": @NO, @"url": url, @"error": @{ @"code": code, @"stage": stage, @"message": message, @"retryable": @(retryable) } });
                fail(code, stage, message, retryable);
            };
            writeBridgeTransaction(@"testflight", operationId, @"requested", @{ @"ok": @YES, @"url": url, @"appleMembership": @"pending" });
            dispatch_async(dispatch_get_main_queue(), ^{
                @try {
                    NSString *deepLink = autoinstallTestFlightDeepLink(url);
                    NSURL *target = [NSURL URLWithString:deepLink];
                    UIApplication *application = [UIApplication sharedApplication];
                    if (!target) {
                        failInvite(@"invalid_request", @"subscribe_invite", @"could not create TestFlight deep link", NO);
                        return;
                    }
                    if ([application respondsToSelector:@selector(openURL:options:completionHandler:)]) {
                        [application openURL:target options:@{} completionHandler:^(BOOL success) {
                            autoinstallLog([NSString stringWithFormat:@"subscribe_invite openURL completed success=%@", success ? @"YES" : @"NO"]);
                            if (!success) writeBridgeTransaction(@"testflight", operationId, @"failed", @{ @"ok": @NO, @"url": url, @"error": @{ @"code": @"open_url_rejected", @"stage": @"subscribe_invite", @"message": @"TestFlight deep link was rejected", @"retryable": @YES } });
                        }];
                    } else if ([application canOpenURL:target]) {
                        ((BOOL (*)(id, SEL, NSURL *))objc_msgSend)(application, @selector(openURL:), target);
                    } else {
                        failInvite(@"open_url_unavailable", @"subscribe_invite", @"TestFlight deep link could not be opened", YES);
                        return;
                    }
                    autoinstallScheduleInviteControls(0);
                    respond(@{ @"ok": @YES, @"requested": @YES, @"operationId": operationId, @"appleMembership": @"pending" });
                } @catch (NSException *exception) {
                    failInvite(@"subscribe_invite_exception", @"subscribe_invite", [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason], YES);
                }
            });
        } @catch (NSException *exception) {
            fail(@"subscribe_invite_exception", @"subscribe_invite", [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason], YES);
        }
        return;
    }

    if ([action isEqualToString:@"list_apps"]) {
        @try {
            if (!gCatalogManager) {
                fail(@"catalog_unavailable", @"list_apps", @"gCatalogManager not stashed yet", YES);
                return;
            }
            SEL selector = NSSelectorFromString(@"getAllAppsWithRefresh:completionBlock:");
            if (![gCatalogManager respondsToSelector:selector]) {
                fail(@"unsupported", @"list_apps", @"TestFlight app catalog enumeration is unavailable", NO);
                return;
            }
            void (^completion)(id, id) = ^(id value, id error) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    if ([error isKindOfClass:[NSError class]]) {
                        respond(@{ @"ok": @NO, @"error": @{ @"code": @"catalog_refresh_failed", @"stage": @"list_apps", @"message": [error localizedDescription] ?: @"TestFlight app catalog refresh failed", @"retryable": @YES } });
                        return;
                    }
                    id appsValue = value;
                    if (![appsValue isKindOfClass:[NSArray class]] && [appsValue respondsToSelector:@selector(allObjects)]) appsValue = [appsValue allObjects];
                    if (![appsValue isKindOfClass:[NSArray class]]) @try { appsValue = [appsValue valueForKey:@"apps"]; } @catch (NSException *exception) { appsValue = @[]; }
                    NSMutableArray *apps = [NSMutableArray array];
                    if ([appsValue isKindOfClass:[NSArray class]]) {
                        for (id app in appsValue) {
                            @try {
                                id rawAppId = [app valueForKey:@"appID"];
                                id rawBundleId = [app valueForKey:@"bundleID"];
                                NSString *bundleId = [rawBundleId isKindOfClass:[NSString class]] ? rawBundleId : [rawBundleId description];
                                NSInteger appIdValue = [rawAppId respondsToSelector:@selector(longLongValue)] ? [rawAppId longLongValue] : [[rawAppId description] longLongValue];
                                if (appIdValue <= 0 || bundleId.length == 0) continue;
                                NSMutableDictionary *entry = [@{ @"appId": @(appIdValue), @"bundleId": bundleId } mutableCopy];
                                NSDictionary *keys = @{
                                    @"name": @"name",
                                    @"providerName": @"providerName",
                                    @"publicLinkURL": @"publicLinkURL",
                                    @"publicLinkStatus": @"publicLinkStatus",
                                    @"inviteStatus": @"inviteStatus",
                                    @"isPublicLinkUser": @"isPublicLinkUser",
                                };
                                for (NSString *key in keys) {
                                    id rawValue = nil;
                                    @try { rawValue = [app valueForKey:keys[key]]; } @catch (NSException *exception) {}
                                    if (!rawValue || rawValue == [NSNull null]) continue;
                                    if ([rawValue isKindOfClass:[NSURL class]]) rawValue = [rawValue absoluteString];
                                    if ([rawValue isKindOfClass:[NSString class]] || [rawValue isKindOfClass:[NSNumber class]]) entry[key] = rawValue;
                                }
                                [apps addObject:entry];
                            } @catch (NSException *exception) {
                                autoinstallLog([NSString stringWithFormat:@"list_apps: app serialization exception %@ %@", exception.name, exception.reason]);
                            }
                        }
                    }
                    respond(@{ @"ok": @YES, @"apps": apps });
                });
            };
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                @try {
                    BOOL refresh = [req[@"refresh"] respondsToSelector:@selector(boolValue)] && [req[@"refresh"] boolValue];
                    ((void (*)(id, SEL, BOOL, id))objc_msgSend)(gCatalogManager, selector, refresh, [completion copy]);
                } @catch (NSException *exception) {
                    fail(@"list_apps_exception", @"list_apps", [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason], YES);
                }
            });
        } @catch (NSException *exception) {
            fail(@"list_apps_exception", @"list_apps", [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason], YES);
        }
        return;
    }

    if ([action isEqualToString:@"status_invite"]) {
        @try {
            NSString *url = [req[@"url"] isKindOfClass:[NSString class]] ? req[@"url"] : @"";
            NSNumber *appId = [req[@"appId"] isKindOfClass:[NSNumber class]] ? req[@"appId"] : nil;
            if (!autoinstallValidTestFlightInvite(url) || !appId || appId.longLongValue <= 0) {
                fail(@"invalid_request", @"status_invite", @"a canonical invite URL and positive appId are required", NO);
                return;
            }
            NSString *operationId = [req[@"operationId"] isKindOfClass:[NSString class]] ? req[@"operationId"] : [[NSUUID UUID] UUIDString];
            NSDictionary *previous = readBridgeTransaction(@"testflight", operationId);
            if ([previous[@"operationId"] isEqual:operationId] && ![previous[@"state"] isEqualToString:@"failed"]) {
                NSMutableDictionary *resumed = [previous mutableCopy];
                resumed[@"requested"] = @NO;
                resumed[@"resumed"] = @YES;
                respond(resumed);
                return;
            }
            writeBridgeTransaction(@"testflight", operationId, @"requested", @{ @"ok": @YES, @"url": url, @"appId": appId });
            NSString *endpoint = [NSString stringWithFormat:@"https://testflight.apple.com/v2/apps/%@/platforms/ios/trains", appId];
            fetchJSON(endpoint, ^(id json, NSDictionary *error) {
                if (error) {
                    writeBridgeTransaction(@"testflight", operationId, @"failed", @{ @"ok": @NO, @"url": url, @"appId": appId, @"error": error });
                    respond(@{ @"ok": @NO, @"error": error });
                    return;
                }
                BOOL verified = ([json isKindOfClass:[NSArray class]] && [json count] > 0) || ([json isKindOfClass:[NSDictionary class]] && [json count] > 0);
                writeBridgeTransaction(@"testflight", operationId, @"completed", @{ @"ok": @YES, @"url": url, @"appId": appId, @"verified": @(verified) });
                respond(@{ @"ok": @YES, @"requested": @NO, @"operationId": operationId, @"appId": appId, @"verified": @(verified), @"data": json ?: @[] });
            });
        } @catch (NSException *exception) {
            fail(@"status_invite_exception", @"status_invite", [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason], YES);
        }
        return;
    }

    if ([action isEqualToString:@"unsubscribe_invite"]) {
        NSString *bundleId = [req[@"bundleId"] isKindOfClass:[NSString class]] ? req[@"bundleId"] : @"";
        if (bundleId.length == 0 || [bundleId rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-"] invertedSet]].location != NSNotFound) {
            fail(@"invalid_request", @"unsubscribe_invite", @"bundleId is invalid", NO);
            return;
        }
        if ([bundleId isEqualToString:@"com.hammerandchisel.discord"]) {
            fail(@"immutable_subscription", @"unsubscribe_invite", @"Discord TestFlight access is protected and cannot be removed", NO);
            return;
        }
        NSString *operationId = [req[@"operationId"] isKindOfClass:[NSString class]] ? req[@"operationId"] : [NSString stringWithFormat:@"unsubscribe-%@", bundleId];
        NSDictionary *previous = readBridgeTransaction(@"testflight", operationId);
        if ([previous[@"operationId"] isEqual:operationId]) {
            respond(@{ @"ok": @YES, @"requested": @NO, @"resumed": @YES, @"operationId": operationId, @"bundleId": bundleId, @"appleMembership": @"unknown" });
            return;
        }
        writeBridgeTransaction(@"testflight", operationId, @"requested", @{ @"ok": @YES, @"bundleId": bundleId, @"appleMembership": @"unknown" });
        respond(@{ @"ok": @YES, @"requested": @YES, @"operationId": operationId, @"bundleId": bundleId, @"appleMembership": @"unknown" });
        return;
    }

    if ([action isEqualToString:@"install"]) {
        @try {
            NSString *operationId = [req[@"operationId"] isKindOfClass:[NSString class]] ? req[@"operationId"] : [[NSUUID UUID] UUIDString];
            NSDictionary *previousStatus = readBridgeTransaction(@"testflight", operationId);
            if ([previousStatus[@"operationId"] isEqual:operationId]) {
                BOOL completed = [previousStatus[@"state"] isEqualToString:@"completed"];
                respond(@{@"ok": @YES, @"requested": @(!completed), @"resumed": @YES, @"completed": @(completed), @"operationId": operationId});
                return;
            }

            if (!gCatalogManager) {
                fail(@"catalog_unavailable", @"install", @"gCatalogManager not stashed yet", YES);
                return;
            }
            if (!gInstaller) {
                fail(@"installer_unavailable", @"install", @"gInstaller not stashed yet", YES);
                return;
            }

            NSNumber *appId = req[@"appId"];
            NSDictionary *buildDict = req[@"build"];
            if (!appId || !buildDict) {
                fail(@"invalid_request", @"install", @"missing appId or build", NO);
                return;
            }
            beginBackgroundKeepAlive();
            id<TFAppCatalogManagerProtocol> catalogManager = gCatalogManager;
            id app = [catalogManager getAppCatalogCachedAppForAppID:appId];
            if (!app) {
                fail(@"app_not_cached", @"install", @"getAppCatalogCachedAppForAppID: returned nil - is the catalog populated?", YES);
                return;
            }

            Class<TFAppBuildProtocol> buildCls = (Class<TFAppBuildProtocol>)objc_getClass("TFAppBuild");
            id build = [buildCls buildFromDictionary:buildDict];
            if (!build) {
                fail(@"invalid_build", @"install", @"buildFromDictionary: returned nil", NO);
                return;
            }

            id bundleAlloc = [objc_getClass("TFInstallableBundle") alloc];
            id installable = [(id<TFInstallableBundleProtocol>)bundleAlloc initWithApp:app
                                                        build:build
                                                   buildGroup:nil
                                            preinstalledState:0
                                        parentInstalledState:0
                                                canAutoUpdate:NO
                                    allowReinstallSameVersion:YES
                                                      variant:nil];
            if (!installable) {
                fail(@"installable_unavailable", @"install", @"initWithApp:build:... returned nil", YES);
                return;
            }

            autoinstallLog([NSString stringWithFormat:@"install: installable=%@", installable]);
            void (^completion)(void) = ^{
                autoinstallLog(@"install: completionBlock fired");
                writeBridgeTransaction(@"testflight", operationId, @"completed", @{@"ok": @YES, @"appId": appId, @"bundleId": buildDict[@"bundleId"] ?: [NSNull null], @"buildVersion": buildDict[@"cfBundleVersion"] ?: [NSNull null]});
                writeJSONFile(kInstallStatusPath, @{@"ok": @YES, @"operationId": operationId, @"state": @"completed", @"appId": appId});
            };
            id<TFAppInstallerProtocol> installer = gInstaller;
            if (!gPrecheckDelegate) gPrecheckDelegate = [AutoinstallPrecheckDelegate new];
            Class<TFInstallationModeProtocol> modeClass = (Class<TFInstallationModeProtocol>)objc_getClass("TFInstallationMode");
            id mode = [modeClass modeWithUserInitiated:YES interactive:YES autoUpdate:NO];
            if (!mode) {
                fail(@"installation_mode_unavailable", @"install", @"TFInstallationMode did not create an interactive user-initiated mode", YES);
                return;
            }
            NSDictionary *transaction = @{@"ok": @YES, @"appId": appId, @"bundleId": buildDict[@"bundleId"] ?: [NSNull null], @"buildVersion": buildDict[@"cfBundleVersion"] ?: [NSNull null]};
            writeBridgeTransaction(@"testflight", operationId, @"requested", transaction);
            writeJSONFile(kInstallStatusPath, @{@"ok": @YES, @"operationId": operationId, @"state": @"requested", @"appId": appId});
            id result = [installer requestInstall:installable installationMode:mode alertDelegate:gPrecheckDelegate withBackgroundTaskMaster:nil completionBlock:completion];
            autoinstallLog([NSString stringWithFormat:@"install: requestInstall: returned %@", result]);
            respond(@{@"ok": @YES, @"requested": @YES, @"operationId": operationId});
        } @catch (NSException *exception) {
            autoinstallLog([NSString stringWithFormat:@"install: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
            fail(@"install_exception", @"install", [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason], YES);
        }
        return;
    }

    if ([action isEqualToString:@"list_trains"]) {
        NSString *appId = [req[@"appId"] stringValue];
        NSString *url = [NSString stringWithFormat:@"https://testflight.apple.com/v2/apps/%@/platforms/ios/trains", appId];
        fetchJSON(url, ^(id json, NSDictionary *error) {
            if (error) {
                respond(@{@"ok": @NO, @"error": error});
            } else {
                respond(@{@"ok": @YES, @"data": json});
            }
        });
        return;
    }

    if ([action isEqualToString:@"list_builds"]) {
        NSString *appId = [req[@"appId"] stringValue];
        NSString *train = req[@"trainVersion"];
        NSString *url = [NSString stringWithFormat:@"https://testflight.apple.com/v2/apps/%@/platforms/ios/trains/%@/builds", appId, train];
        fetchJSON(url, ^(id json, NSDictionary *error) {
            if (error) {
                respond(@{@"ok": @NO, @"error": error});
            } else {
                respond(@{@"ok": @YES, @"data": json});
            }
        });
        return;
    }

    if ([action isEqualToString:@"status"]) {
        NSMutableDictionary *response = [bridgeStatus() mutableCopy];
        response[@"ok"] = @YES;
        response[@"install"] = readJSONFile(kInstallStatusPath) ?: @{};
        respond(response);
        return;
    }

    if ([action isEqualToString:@"diagnostics"]) {
        respond(@{
            @"ok": @YES,
            @"data": @{
                @"bridge": bridgeStatus(),
                @"install": readJSONFile(kInstallStatusPath) ?: @{},
                @"recentLog": recentBridgeLogEntries(),
            },
        });
        return;
    }

    if ([action isEqualToString:@"end_background_keepalive"]) {
        endBackgroundKeepAlive();
        respond(@{@"ok": @YES});
        return;
    }

    fail(@"unknown_action", @"request", [NSString stringWithFormat:@"unknown action: %@", action], NO);
}

static dispatch_queue_t gBridgeQueue = nil;
static dispatch_source_t gBridgeTimer = nil;

static void startTestFlightSide(void) {
    gBridgeQueue = dispatch_queue_create("dev.adrian.autoinstall.bridge", DISPATCH_QUEUE_SERIAL);
    gBridgeTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gBridgeQueue);
    dispatch_source_set_timer(gBridgeTimer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_MSEC * 200);
    dispatch_source_set_event_handler(gBridgeTimer, ^{
        @autoreleasepool {
        NSFileManager *fm = [NSFileManager defaultManager];
        writeBridgeHeartbeat(@"testflight");
        sweepBridgeArtifacts(@"testflight");
        processSecureBridgeRequests(@"testflight", ^(NSDictionary *request, NSString *responsePath, NSString *requestId) {
            handleRequest(request, responsePath, requestId);
        });
        if (![fm fileExistsAtPath:kRequestPath]) return;

        NSData *data = [NSData dataWithContentsOfFile:kRequestPath];
        [fm removeItemAtPath:kRequestPath error:nil];
        if (!data) return;

        NSError *err = nil;
        NSDictionary *req = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
        if (!req) {
            autoinstallLog([NSString stringWithFormat:@"bridge: bad request json: %@", err]);
            return;
        }
        rejectLegacyBridgeRequest(req, kResponsePath);
        }
    });
    dispatch_resume(gBridgeTimer);
    autoinstallLog(@"bridge: request-file watcher started");
}

static BOOL gIsAppStoreProcess = NO;
static BOOL gIsAuthUIService = NO;

static id gStashedConfirmVC = nil;
static BOOL gConfirmDoneThisSheet = NO;
static BOOL gConfirmAttemptActive = NO;
static BOOL gPaymentAuthorizationPromptVisible = NO;
static __weak UIViewController *gPaymentAuthorizationPromptController = nil;
static BOOL gFreeInstallConfirmationAttempted = NO;
static NSString *gFreeInstallDiagnosticOperationId = nil;
static BOOL gFreeInstallDiagnosticHasLabels = NO;
static int gPaymentAuthorizationGuardLockFd = -1;
static __weak id gPasswordSubmissionField = nil;

static int autoinstallTryAcquirePaymentAuthorizationGuardLock(void) {
    int fd = open(kPaymentAuthorizationGuardLockPath.fileSystemRepresentation, O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    if (fd < 0) return -1;
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static void autoinstallReleasePaymentAuthorizationGuardLock(int fd) {
    if (fd < 0) return;
    flock(fd, LOCK_UN);
    close(fd);
}

static void autoinstallHoldPaymentAuthorizationGuardLock(void) {
    if (gPaymentAuthorizationGuardLockFd >= 0) return;
    gPaymentAuthorizationGuardLockFd = autoinstallTryAcquirePaymentAuthorizationGuardLock();
}

static NSString *autoinstallPaymentAuthorizationGuardPath(pid_t pid) {
    return [kPaymentAuthorizationGuardDirectory stringByAppendingPathComponent:[NSString stringWithFormat:@"%d.json", pid]];
}

static void autoinstallWritePaymentAuthorizationGuard(NSString *className) {
    [[NSFileManager defaultManager] createDirectoryAtPath:kPaymentAuthorizationGuardDirectory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];
    writeJSONFile(autoinstallPaymentAuthorizationGuardPath([[NSProcessInfo processInfo] processIdentifier]), @{
        @"pid": @([[NSProcessInfo processInfo] processIdentifier]),
        @"process": [[NSProcessInfo processInfo] processName] ?: @"unknown",
        @"viewController": className ?: @"unknown",
        @"updatedAt": @([[NSDate date] timeIntervalSince1970])
    });
}

static BOOL autoinstallSharedPaymentAuthorizationGuardActiveLocked(void) {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSError *error = nil;
    NSArray *files = [fileManager contentsOfDirectoryAtPath:kPaymentAuthorizationGuardDirectory error:&error];
    if (!files) return [fileManager fileExistsAtPath:kPaymentAuthorizationGuardDirectory];
    NSTimeInterval now = [NSDate date].timeIntervalSince1970;
    for (NSString *file in files) {
        if (![file.pathExtension isEqualToString:@"json"]) continue;
        NSString *path = [kPaymentAuthorizationGuardDirectory stringByAppendingPathComponent:file];
        NSDictionary *guard = readJSONFile(path);
        pid_t pid = [guard[@"pid"] respondsToSelector:@selector(intValue)] ? [guard[@"pid"] intValue] : 0;
        NSTimeInterval updatedAt = [guard[@"updatedAt"] respondsToSelector:@selector(doubleValue)] ? [guard[@"updatedAt"] doubleValue] : 0;
        if (pid <= 0 || updatedAt <= 0 || now - updatedAt > 10.0) {
            [fileManager removeItemAtPath:path error:nil];
            continue;
        }
        errno = 0;
        if (kill(pid, 0) == 0 || errno == EPERM) return YES;
        [fileManager removeItemAtPath:path error:nil];
    }
    return NO;
}

static BOOL autoinstallPaymentAuthorizationPromptPendingLocked(void) {
    return gPaymentAuthorizationPromptVisible || autoinstallSharedPaymentAuthorizationGuardActiveLocked();
}

static void autoinstallClearPaymentAuthorizationGuard(void) {
    [[NSFileManager defaultManager] removeItemAtPath:autoinstallPaymentAuthorizationGuardPath([[NSProcessInfo processInfo] processIdentifier]) error:nil];
    gPaymentAuthorizationPromptVisible = NO;
    gPaymentAuthorizationPromptController = nil;
    gFreeInstallConfirmationAttempted = NO;
    int lockFd = gPaymentAuthorizationGuardLockFd;
    gPaymentAuthorizationGuardLockFd = -1;
    autoinstallReleasePaymentAuthorizationGuardLock(lockFd);
}

static BOOL autoinstallIsPaymentAuthorizationController(UIViewController *controller) {
    NSString *className = NSStringFromClass([controller class]);
    return [className containsString:@"PKPaymentAuthorizationRemoteAlertViewController"] || [className containsString:@"InAppPayment"];
}

static void autoinstallRecordPaymentAuthorizationPrompt(NSString *className) {
    gPaymentAuthorizationPromptVisible = YES;
    autoinstallWritePaymentAuthorizationGuard(className);
    markAppStoreInstallAuthorizationPending(className);
    if (!gIsPassbookProcess) {
        gConfirmDoneThisSheet = YES;
        gConfirmAttemptActive = NO;
        autoinstallClearAutoConfirmFlags();
    }
    autoinstallHoldPaymentAuthorizationGuardLock();
}

static void autoinstallMarkPaymentAuthorizationPrompt(UIViewController *controller) {
    if (gPaymentAuthorizationPromptController != controller) gFreeInstallConfirmationAttempted = NO;
    gPaymentAuthorizationPromptController = controller;
    NSString *className = NSStringFromClass([controller class]);
    autoinstallRecordPaymentAuthorizationPrompt(className);
}

static BOOL autoinstallVisibleControllerContainsPaymentAuthorization(UIViewController *controller, NSHashTable *visited, NSString **matchedClass) {
    if (!controller || [visited containsObject:controller]) return NO;
    [visited addObject:controller];
    NSString *className = NSStringFromClass([controller class]);
    if ([className containsString:@"PKPaymentAuthorizationRemoteAlertViewController"] || [className containsString:@"InAppPayment"]) {
        if (matchedClass) *matchedClass = className;
        return YES;
    }
    if (autoinstallVisibleControllerContainsPaymentAuthorization(controller.presentedViewController, visited, matchedClass)) return YES;
    if ([controller isKindOfClass:[UINavigationController class]]) {
        if (autoinstallVisibleControllerContainsPaymentAuthorization(((UINavigationController *)controller).visibleViewController, visited, matchedClass)) return YES;
    }
    if ([controller isKindOfClass:[UITabBarController class]]) {
        if (autoinstallVisibleControllerContainsPaymentAuthorization(((UITabBarController *)controller).selectedViewController, visited, matchedClass)) return YES;
    }
    for (UIViewController *child in controller.childViewControllers) {
        if (child.viewIfLoaded.window && autoinstallVisibleControllerContainsPaymentAuthorization(child, visited, matchedClass)) return YES;
    }
    return NO;
}

static NSString *autoinstallVisiblePaymentAuthorizationClass(void) {
    if (!(gIsPassbookProcess || gIsAuthUIService)) return nil;
    NSHashTable *visited = [NSHashTable hashTableWithOptions:NSPointerFunctionsObjectPointerPersonality | NSPointerFunctionsStrongMemory];
    NSString *matchedClass = nil;
    @try {
        for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) continue;
            for (UIWindow *window in [(UIWindowScene *)scene windows]) {
                if (autoinstallVisibleControllerContainsPaymentAuthorization(window.rootViewController, visited, &matchedClass)) break;
            }
            if (matchedClass) break;
        }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        if (!matchedClass) {
            for (UIWindow *window in [UIApplication sharedApplication].windows) {
                if (autoinstallVisibleControllerContainsPaymentAuthorization(window.rootViewController, visited, &matchedClass)) break;
            }
        }
#pragma clang diagnostic pop
    } @catch (NSException *exception) {
        autoinstallLog([NSString stringWithFormat:@"payment authorization visibility check failed: %@", exception]);
    }
    return matchedClass;
}

static BOOL autoinstallPaymentAuthorizationPromptVisible(void) {
    if (gPaymentAuthorizationPromptVisible) {
        autoinstallWritePaymentAuthorizationGuard(@"PKPaymentAuthorizationRemoteAlertViewController");
        autoinstallHoldPaymentAuthorizationGuardLock();
        return YES;
    }
    NSString *className = autoinstallVisiblePaymentAuthorizationClass();
    if (className) {
        gPaymentAuthorizationPromptController = nil;
        autoinstallRecordPaymentAuthorizationPrompt(className);
        return YES;
    }
    int lockFd = autoinstallTryAcquirePaymentAuthorizationGuardLock();
    if (lockFd < 0) return YES;
    BOOL active = autoinstallPaymentAuthorizationPromptPendingLocked();
    autoinstallReleasePaymentAuthorizationGuardLock(lockFd);
    return active;
}

static void autoinstallRefreshPaymentAuthorizationPromptGuard(void) {
    if (!gPaymentAuthorizationPromptVisible) return;
    UIViewController *controller = gPaymentAuthorizationPromptController;
    NSString *className = controller && controller.viewIfLoaded.window && autoinstallIsPaymentAuthorizationController(controller)
        ? NSStringFromClass([controller class])
        : autoinstallVisiblePaymentAuthorizationClass();
    if (!className) {
        autoinstallClearPaymentAuthorizationGuard();
        return;
    }
    autoinstallWritePaymentAuthorizationGuard(className);
    autoinstallHoldPaymentAuthorizationGuardLock();
}

static BOOL autoinstallRunWithPaymentAuthorizationGuard(void (^action)(void)) {
    if (gPaymentAuthorizationPromptVisible) return NO;
    int lockFd = autoinstallTryAcquirePaymentAuthorizationGuardLock();
    if (lockFd < 0) return NO;
    BOOL active = autoinstallPaymentAuthorizationPromptPendingLocked();
    if (!active && action) {
        @try {
            action();
        } @finally {
            autoinstallReleasePaymentAuthorizationGuardLock(lockFd);
        }
        return YES;
    }
    autoinstallReleasePaymentAuthorizationGuardLock(lockFd);
    return NO;
}

static void autoinstallWalkAX(id element, void (^visit)(id el)) {
    if (!element) return;
    visit(element);
    @try {
        NSArray *axKids = nil;
        if ([element respondsToSelector:@selector(accessibilityElements)]) {
            axKids = [element accessibilityElements];
        }
        if (axKids.count) {
            for (id k in axKids) autoinstallWalkAX(k, visit);
        } else if ([element respondsToSelector:@selector(accessibilityElementCount)]) {
            NSInteger n = [element accessibilityElementCount];
            if (n > 0 && n != NSNotFound) {
                for (NSInteger i = 0; i < n; i++) autoinstallWalkAX([element accessibilityElementAtIndex:i], visit);
            }
        }
        if ([element isKindOfClass:[UIView class]]) {
            for (UIView *sub in [(UIView *)element subviews]) autoinstallWalkAX(sub, visit);
        }
    } @catch (NSException *e) {}
}

static void autoinstallTryConfirmFreeAppStoreAuthorization(void) {
    if (!gIsPassbookProcess || !gPaymentAuthorizationPromptVisible || gFreeInstallConfirmationAttempted) return;
    NSDictionary *authorization = autoinstallActiveFreeAppStoreAuthorization();
    if (!authorization) return;
    NSMutableArray<NSString *> *labels = [NSMutableArray array];
    NSMutableArray<NSString *> *buttons = [NSMutableArray array];
    NSMutableArray *buttonElements = [NSMutableArray array];
    NSMutableArray *roots = [NSMutableArray array];
    UIView *controllerView = gPaymentAuthorizationPromptController.viewIfLoaded;
    if (controllerView) [roots addObject:controllerView];
    UIView *hostingView = [gStashedConfirmVC isKindOfClass:[UIViewController class]] ? [(UIViewController *)gStashedConfirmVC viewIfLoaded] : nil;
    if (hostingView && ![roots containsObject:hostingView]) [roots addObject:hostingView];
    for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        for (UIWindow *window in [(UIWindowScene *)scene windows]) {
            if (window && ![roots containsObject:window]) [roots addObject:window];
        }
    }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    for (UIWindow *window in [UIApplication sharedApplication].windows) {
        if (window && ![roots containsObject:window]) [roots addObject:window];
    }
#pragma clang diagnostic pop
    NSHashTable *visited = [NSHashTable hashTableWithOptions:NSPointerFunctionsObjectPointerPersonality | NSPointerFunctionsStrongMemory];
    for (id root in roots) {
        autoinstallWalkAX(root, ^(id element) {
            if ([visited containsObject:element]) return;
            [visited addObject:element];
            NSMutableArray<NSString *> *values = [NSMutableArray array];
            @try {
                if ([element respondsToSelector:@selector(accessibilityLabel)]) {
                    id label = [element accessibilityLabel];
                    if ([label isKindOfClass:[NSString class]] && [label length]) [values addObject:label];
                }
                if ([element respondsToSelector:@selector(currentTitle)]) {
                    id title = [element currentTitle];
                    if ([title isKindOfClass:[NSString class]] && [title length]) [values addObject:title];
                }
                if ([element respondsToSelector:@selector(text)]) {
                    id text = [element text];
                    if ([text isKindOfClass:[NSString class]] && [text length]) [values addObject:text];
                }
            } @catch (NSException *exception) {}
            BOOL isButton = NO;
            @try {
                isButton = [element isKindOfClass:[UIControl class]] || ([element respondsToSelector:@selector(accessibilityTraits)] && ([element accessibilityTraits] & UIAccessibilityTraitButton) != 0);
            } @catch (NSException *exception) {}
            for (NSString *value in values) {
                if (![labels containsObject:value]) [labels addObject:value];
                if (!isButton) continue;
                if (![buttons containsObject:value]) [buttons addObject:value];
                NSString *title = [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
                if (([title caseInsensitiveCompare:@"Install"] == NSOrderedSame || [title caseInsensitiveCompare:@"Installieren"] == NSOrderedSame) && ![buttonElements containsObject:element]) [buttonElements addObject:element];
            }
        });
    }
    NSTimeInterval age = [NSDate date].timeIntervalSince1970 - [authorization[@"issuedAt"] doubleValue];
    NSArray<NSString *> *appNames = [authorization[@"appNames"] isKindOfClass:[NSArray class]] ? authorization[@"appNames"] : @[authorization[@"appName"] ?: @""];
    BOOL canConfirm = appNames.count > 1
        ? autoinstallCanConfirmFreeInstallForNames(appNames, labels, buttons, authorization[@"verifiedPrice"], age)
        : autoinstallCanConfirmFreeInstall(appNames.firstObject, labels, buttons, authorization[@"verifiedPrice"], age);
    BOOL newDiagnosticOperation = ![gFreeInstallDiagnosticOperationId isEqualToString:authorization[@"operationId"]];
    if (newDiagnosticOperation) gFreeInstallDiagnosticHasLabels = NO;
    if (newDiagnosticOperation || (labels.count > 0 && !gFreeInstallDiagnosticHasLabels)) {
        gFreeInstallDiagnosticOperationId = authorization[@"operationId"];
        gFreeInstallDiagnosticHasLabels = labels.count > 0;
        BOOL headingFound = NO;
        BOOL appNameFound = NO;
        BOOL installLabelFound = NO;
        for (NSString *label in labels) {
            if (autoinstallLabelContainsCanonicalPhrase(label, @"app store")) headingFound = YES;
            for (NSString *appName in appNames) {
                if ([appName isKindOfClass:[NSString class]] && autoinstallLabelContainsCanonicalPhrase(label, autoinstallCanonicalAppName(appName))) appNameFound = YES;
            }
            if ([label caseInsensitiveCompare:@"Install"] == NSOrderedSame || [label caseInsensitiveCompare:@"Installieren"] == NSOrderedSame) installLabelFound = YES;
        }
        autoinstallLog([NSString stringWithFormat:@"free App Store confirmation scan roots=%lu labels=%lu buttons=%lu heading=%@ app=%@ installLabel=%@ eligible=%@ operationId=%@", (unsigned long)roots.count, (unsigned long)labels.count, (unsigned long)buttons.count, headingFound ? @"yes" : @"no", appNameFound ? @"yes" : @"no", installLabelFound ? @"yes" : @"no", canConfirm ? @"yes" : @"no", authorization[@"operationId"]]);
    }
    if (!canConfirm || !buttonElements.count) return;
    gFreeInstallConfirmationAttempted = YES;
    id button = buttonElements.firstObject;
    BOOL activated = NO;
    @try {
        if ([button respondsToSelector:@selector(accessibilityActivate)]) activated = [button accessibilityActivate];
        if (!activated && [button isKindOfClass:[UIControl class]]) {
            [(UIControl *)button sendActionsForControlEvents:UIControlEventTouchUpInside];
            activated = YES;
        }
    } @catch (NSException *exception) {
        autoinstallLog([NSString stringWithFormat:@"free App Store confirmation failed: %@", exception.name]);
    }
    autoinstallLog([NSString stringWithFormat:@"free App Store confirmation activation=%@ operationId=%@", activated ? @"yes" : @"no", authorization[@"operationId"]]);
}

static void autoinstallEnableAX(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        void *h = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW);
        if (!h) { autoinstallLog(@"AX: dlopen libAccessibility failed"); return; }
        void (*setApp)(Boolean) = (void (*)(Boolean))dlsym(h, "_AXSApplicationAccessibilitySetEnabled");
        void (*setAuto)(Boolean) = (void (*)(Boolean))dlsym(h, "_AXSSetAutomationEnabled");
        if (setApp) setApp(true);
        if (setAuto) setAuto(true);
        autoinstallLog(@"AX: automation enabled");
    });
}

static NSString *autoinstallGetPassword(void) {
    NSArray *paths = @[
        @"/tmp/autoinstall-password.txt",
        @"/var/mobile/Library/Preferences/dev.adrian.autoinstall-password.txt",
        @"/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall-password.txt",
        @"/private/var/mobile/Library/Caches/com.apple.AuthKitUIService/autoinstall-password.txt",
        @"/private/var/mobile/Library/Caches/com.apple.ios.StoreKitUIService/autoinstall-password.txt"
    ];
    NSFileManager *fm = [NSFileManager defaultManager];
    for (NSString *path in paths) {
        @try {
            if ([fm fileExistsAtPath:path]) {
                NSString *content = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
                content = [content stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
                if (content.length > 0) {
                    return content;
                }
            }
        } @catch (NSException *e) {}
    }
    return nil;
}

static BOOL autoinstallHandlePasswordIfPresentUnlocked(void) {
    NSString *password = autoinstallGetPassword();
    if (!password.length) return NO;

    NSMutableArray *roots = [NSMutableArray array];
    if (gStashedConfirmVC) {
        @try {
            UIView *v = [(id)gStashedConfirmVC view];
            if (v) [roots addObject:v];
        } @catch (NSException *e) {}
    }
    @try {
        for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
            if ([scene isKindOfClass:[UIWindowScene class]]) {
                for (UIWindow *w in [(UIWindowScene *)scene windows]) {
                    if (w) [roots addObject:w];
                }
            }
        }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        for (UIWindow *w in [UIApplication sharedApplication].windows) {
            if (w && ![roots containsObject:w]) [roots addObject:w];
        }
        UIWindow *key = [UIApplication sharedApplication].keyWindow;
        if (key && ![roots containsObject:key]) [roots addObject:key];
#pragma clang diagnostic pop
    } @catch (NSException *e) {}

    NSMutableArray *allRoots = [roots mutableCopy];
    for (id r in roots) {
        if ([r isKindOfClass:[UIWindow class]]) {
            UIViewController *rvc = [(UIWindow *)r rootViewController];
            while (rvc) {
                if (rvc.view && ![allRoots containsObject:rvc.view]) {
                    [allRoots addObject:rvc.view];
                }
                rvc = rvc.presentedViewController;
            }
        }
    }

    __block id foundField = nil;
    __block id foundButton = nil;

    for (id root in allRoots) {
        autoinstallWalkAX(root, ^(id el) {
            if ([el isKindOfClass:[UIWindow class]]) return;
            NSString *cls = NSStringFromClass([el class]);
            if ([cls rangeOfString:@"Window" options:NSCaseInsensitiveSearch].location != NSNotFound) return;

            BOOL isCandidateTF = NO;
            if ([el isKindOfClass:[UITextField class]]) {
                isCandidateTF = YES;
            } else if ([cls rangeOfString:@"TextField" options:NSCaseInsensitiveSearch].location != NSNotFound ||
                       [cls rangeOfString:@"TextEntry" options:NSCaseInsensitiveSearch].location != NSNotFound) {
                isCandidateTF = YES;
            } else if ([el conformsToProtocol:@protocol(UITextInput)] || [el conformsToProtocol:@protocol(UIKeyInput)]) {
                isCandidateTF = YES;
            }

            if (isCandidateTF) {
                BOOL isSecure = NO;
                if ([el respondsToSelector:@selector(isSecureTextEntry)]) {
                    isSecure = [el isSecureTextEntry];
                }
                NSString *placeholder = @"";
                if ([el respondsToSelector:@selector(placeholder)]) {
                    placeholder = [el placeholder] ?: @"";
                }
                NSString *accLabel = @"";
                @try { if ([el respondsToSelector:@selector(accessibilityLabel)]) accLabel = [el accessibilityLabel] ?: @""; } @catch (NSException *e) {}

                BOOL isPassword = isSecure ||
                    [placeholder rangeOfString:@"password" options:NSCaseInsensitiveSearch].location != NSNotFound ||
                    [accLabel rangeOfString:@"password" options:NSCaseInsensitiveSearch].location != NSNotFound ||
                    [cls rangeOfString:@"Secure" options:NSCaseInsensitiveSearch].location != NSNotFound ||
                    [cls rangeOfString:@"Password" options:NSCaseInsensitiveSearch].location != NSNotFound;

                if (gIsAuthUIService && !isPassword) {
                    isPassword = YES;
                }

                if (isPassword) {
                    foundField = el;
                }
            }

            NSString *label = @"";
            @try { if ([el respondsToSelector:@selector(accessibilityLabel)]) label = [el accessibilityLabel] ?: @""; } @catch (NSException *e) {}
            NSString *title = @"";
            @try { if ([el respondsToSelector:@selector(currentTitle)]) title = [(UIButton *)el currentTitle] ?: @""; } @catch (NSException *e) {}
            NSString *hay = [NSString stringWithFormat:@"%@|%@", label, title];
            if ([hay rangeOfString:@"Sign In" options:NSCaseInsensitiveSearch].location != NSNotFound ||
                [hay rangeOfString:@"Sign-In" options:NSCaseInsensitiveSearch].location != NSNotFound ||
                [hay rangeOfString:@"Log In" options:NSCaseInsensitiveSearch].location != NSNotFound ||
                [hay rangeOfString:@"Continue" options:NSCaseInsensitiveSearch].location != NSNotFound) {
                foundButton = el;
            }
        });
        if (foundField && foundButton) break;
    }

    if (foundField) {
        if (autoinstallPaymentAuthorizationPromptPendingLocked()) return NO;
        autoinstallLog([NSString stringWithFormat:@"[Auth] Found password field (%@), setting text (length=%lu)", NSStringFromClass([foundField class]), (unsigned long)password.length]);
        if ([foundField respondsToSelector:@selector(setText:)]) {
            [foundField setText:password];
        }
        if (autoinstallPaymentAuthorizationPromptPendingLocked()) return NO;
        if ([foundField respondsToSelector:@selector(sendActionsForControlEvents:)]) {
            [foundField sendActionsForControlEvents:UIControlEventEditingChanged];
            if (autoinstallPaymentAuthorizationPromptPendingLocked()) return NO;
            [foundField sendActionsForControlEvents:UIControlEventEditingDidEnd];
            if (autoinstallPaymentAuthorizationPromptPendingLocked()) return NO;
        }
        @try {
            [[NSNotificationCenter defaultCenter] postNotificationName:UITextFieldTextDidChangeNotification object:foundField];
        } @catch (NSException *e) {}
        if (autoinstallPaymentAuthorizationPromptPendingLocked()) return NO;

        if ([foundField conformsToProtocol:@protocol(UIKeyInput)]) {
            @try {
                id<UIKeyInput> ki = (id<UIKeyInput>)foundField;
                if ([ki respondsToSelector:@selector(hasText)] && ![ki hasText]) {
                    [ki insertText:password];
                }
            } @catch (NSException *e) {}
        }
        if (autoinstallPaymentAuthorizationPromptPendingLocked()) return NO;

        if (foundButton) {
            if (gPasswordSubmissionField == foundField) return YES;
            gPasswordSubmissionField = foundField;
            autoinstallLog([NSString stringWithFormat:@"[Auth] Found submit button (%@), activating...", NSStringFromClass([foundButton class])]);
            void (^actuateButtonUnlocked)(void) = ^{
                @try {
                    if (autoinstallPaymentAuthorizationPromptPendingLocked()) return;
                    if ([foundButton respondsToSelector:@selector(accessibilityActivate)]) {
                        [foundButton accessibilityActivate];
                    } else if ([foundButton isKindOfClass:[UIControl class]]) {
                        [(UIControl *)foundButton sendActionsForControlEvents:UIControlEventTouchUpInside];
                    } else if ([foundButton isKindOfClass:[UIView class]]) {
                        UIView *p = [(UIView *)foundButton superview];
                        while (p) {
                            if ([p isKindOfClass:[UIControl class]]) {
                                [(UIControl *)p sendActionsForControlEvents:UIControlEventTouchUpInside];
                                break;
                            }
                            p = [p superview];
                        }
                    }
                } @catch (NSException *e) {}
            };
            actuateButtonUnlocked();
        }
        return YES;
    }
    return NO;
}

static BOOL autoinstallHandlePasswordIfPresent(void) {
    if (!autoinstallGetPassword().length || autoinstallPaymentAuthorizationPromptVisible()) return NO;
    __block BOOL handled = NO;
    if (!autoinstallRunWithPaymentAuthorizationGuard(^{
        handled = autoinstallHandlePasswordIfPresentUnlocked();
    })) return NO;
    return handled;
}

static NSArray *autoinstallConfirmMatchingUnlocked(NSString *match) {
    NSMutableArray *acted = [NSMutableArray array];
    __block BOOL paymentAuthorizationPromptPending = NO;
    __block BOOL actionAttempted = NO;

    // 1. Direct inspection and dismissal of any presented UIAlertController
    @try {
        for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) continue;
            for (UIWindow *w in [(UIWindowScene *)scene windows]) {
                UIViewController *vc = w.rootViewController;
                while (vc) {
                    if ([vc isKindOfClass:[UIAlertController class]]) {
                        UIAlertController *alert = (UIAlertController *)vc;
                        for (UIAlertAction *act in alert.actions) {
                            NSString *title = act.title ?: @"";
                            BOOL isNegative = NO;
                            NSArray *negativeTerms = @[@"don't", @"don’t", @"not now", @"cancel", @"deny", @"disallow", @"never", @"no thanks"];
                            for (NSString *neg in negativeTerms) {
                                if ([title rangeOfString:neg options:NSCaseInsensitiveSearch].location != NSNotFound) {
                                    isNegative = YES;
                                    break;
                                }
                            }
                            if (isNegative) continue;

                            BOOL matchAlert = NO;
                            if (match.length && [title rangeOfString:match options:NSCaseInsensitiveSearch].location != NSNotFound) {
                                matchAlert = YES;
                            }
                            if (!matchAlert) {
                                NSArray *alertTerms = @[
                                    @"Require After 15 Minutes", @"Always Require",
                                    @"Install", @"Buy", @"Confirm", @"Save",
                                    @"Always Allow", @"Allow", @"Yes", @"OK",
                                    @"Done", @"Continue"
                                ];
                                for (NSString *term in alertTerms) {
                                    if ([title rangeOfString:term options:NSCaseInsensitiveSearch].location != NSNotFound) {
                                        matchAlert = YES;
                                        break;
                                    }
                                }
                            }
                            if (matchAlert) {
                                if (autoinstallPaymentAuthorizationPromptPendingLocked()) return acted;
                                autoinstallLog([NSString stringWithFormat:@"[Alert] Dismissing UIAlertController with action: %@", title]);
                                id handler = nil;
                                @try { handler = [act valueForKey:@"handler"]; } @catch (NSException *e) {}
                                if (!handler) handler = getIvarObject(act, "_handler");
                                [acted addObject:@{@"type": @"UIAlertController", @"title": title}];
                                if ([alert respondsToSelector:sel_registerName("_dismissWithAction:")]) {
                                    @try {
                                        ((void (*)(id, SEL, id))objc_msgSend)(alert, sel_registerName("_dismissWithAction:"), act);
                                    } @catch (NSException *e) {}
                                } else {
                                    if (handler) {
                                        @try {
                                            void (^block)(id) = handler;
                                            block(act);
                                        } @catch (NSException *e) {}
                                    }
                                    if (!autoinstallPaymentAuthorizationPromptPendingLocked()) {
                                        @try {
                                        [alert dismissViewControllerAnimated:YES completion:nil];
                                        } @catch (NSException *e) {}
                                    }
                                }
                                return acted;
                            }
                        }
                    }
                    vc = vc.presentedViewController;
                }
            }
        }
    } @catch (NSException *e) {
        autoinstallLog([NSString stringWithFormat:@"[Alert] Exception checking UIAlertController: %@", e]);
    }

    // 2. View tree search across all windows and stashed VCs
    NSMutableArray *roots = [NSMutableArray array];
    if (gStashedConfirmVC) {
        @try {
            UIView *v = [(id)gStashedConfirmVC view];
            if (v) [roots addObject:v];
        } @catch (NSException *e) {}
    }
    @try {
        for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
            if ([scene isKindOfClass:[UIWindowScene class]]) {
                for (UIWindow *w in [(UIWindowScene *)scene windows]) {
                    if (w) [roots addObject:w];
                }
            }
        }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        for (UIWindow *w in [UIApplication sharedApplication].windows) {
            if (w && ![roots containsObject:w]) [roots addObject:w];
        }
#pragma clang diagnostic pop
    } @catch (NSException *e) {}

    for (id root in roots) {
        autoinstallWalkAX(root, ^(id el) {
            if (paymentAuthorizationPromptPending || actionAttempted) return;
            if (autoinstallPaymentAuthorizationPromptPendingLocked()) {
                paymentAuthorizationPromptPending = YES;
                return;
            }
            NSString *label = @"";
            @try { if ([el respondsToSelector:@selector(accessibilityLabel)]) label = [el accessibilityLabel] ?: @""; } @catch (NSException *e) {}
            NSString *title = @"";
            @try { if ([el respondsToSelector:@selector(currentTitle)]) title = [(UIButton *)el currentTitle] ?: @""; } @catch (NSException *e) {}
            NSString *text = @"";
            @try { if ([el respondsToSelector:@selector(text)]) text = [(UILabel *)el text] ?: @""; } @catch (NSException *e) {}
            NSString *ident = @"";
            @try { if ([el respondsToSelector:@selector(accessibilityIdentifier)]) ident = [el accessibilityIdentifier] ?: @""; } @catch (NSException *e) {}
            NSString *cls = NSStringFromClass([el class]);
            NSString *hay = [NSString stringWithFormat:@"%@|%@|%@|%@|%@", cls, label, title, text, ident];
            NSString *visibleText = [NSString stringWithFormat:@"%@|%@|%@", label, title, text];
            NSArray *negativeTerms = @[@"don't", @"don’t", @"not now", @"cancel", @"deny", @"disallow", @"never", @"no thanks"];
            for (NSString *neg in negativeTerms) {
                if ([visibleText rangeOfString:neg options:NSCaseInsensitiveSearch].location != NSNotFound) {
                    return;
                }
            }
            if (gIsAppStoreProcess) {
                if ([cls containsString:@"OfferButton"]) return;
                if ([el isKindOfClass:[UIView class]]) {
                    UIView *p = [(UIView *)el superview];
                    BOOL isFeed = NO;
                    while (p) {
                        NSString *pcls = NSStringFromClass([p class]);
                        if ([pcls containsString:@"OfferButton"] || [pcls containsString:@"Shelf"] || [pcls containsString:@"CollectionView"]) {
                            isFeed = YES;
                            break;
                        }
                        p = [p superview];
                    }
                    if (isFeed) return;
                }
            }

            BOOL matched = NO;
            if (match.length && [hay rangeOfString:match options:NSCaseInsensitiveSearch].location != NSNotFound) {
                matched = YES;
            }
            if (!matched) {
                NSArray *terms = @[
                    @"Require After 15 Minutes", @"Always Require",
                    @"Install", @"Buy", @"Confirm", @"Save",
                    @"Always Allow", @"Allow", @"Yes", @"OK",
                    @"Done", @"Continue", @"Sign In", @"Sign-In"
                ];
                for (NSString *t in terms) {
                    if ([hay rangeOfString:t options:NSCaseInsensitiveSearch].location != NSNotFound) {
                        matched = YES;
                        break;
                    }
                }
            }
            if (!matched) return;
            NSMutableDictionary *rec = [@{@"class": cls, @"label": label, @"title": title, @"text": text} mutableCopy];
            id act = nil;
            if ([el respondsToSelector:sel_registerName("action")]) {
                act = ((id (*)(id, SEL))objc_msgSend)(el, sel_registerName("action"));
            }
            if (!act) act = getIvarObject(el, "_action");
            BOOL invoked = NO;
            @try {
                if ([el respondsToSelector:@selector(accessibilityActivate)]) {
                    invoked = YES;
                    rec[@"accessibilityActivate"] = @([el accessibilityActivate]);
                } else if ([el respondsToSelector:sel_registerName("_actionTriggered")]) {
                    invoked = YES;
                    ((void (*)(id, SEL))objc_msgSend)(el, sel_registerName("_actionTriggered"));
                    rec[@"_actionTriggered"] = @YES;
                } else if (act) {
                    id handler = nil;
                    @try { handler = [act valueForKey:@"handler"]; } @catch (NSException *e) {}
                    if (!handler) handler = getIvarObject(act, "_handler");
                    if (handler) {
                        invoked = YES;
                        void (^block)(id) = handler;
                        block(act);
                        rec[@"calledActionHandler"] = @YES;
                    }
                } else if ([el isKindOfClass:[UIControl class]]) {
                    invoked = YES;
                    [(UIControl *)el sendActionsForControlEvents:UIControlEventTouchUpInside];
                    rec[@"sentControlEvents"] = @YES;
                } else if ([el isKindOfClass:[UIView class]]) {
                    UIView *p = [(UIView *)el superview];
                    while (p) {
                        if ([p isKindOfClass:[UIControl class]]) {
                            invoked = YES;
                            [(UIControl *)p sendActionsForControlEvents:UIControlEventTouchUpInside];
                            rec[@"sentParentControlEvents"] = NSStringFromClass([p class]);
                            break;
                        }
                        p = [p superview];
                    }
                }
            } @catch (NSException *e) {
                rec[@"exception"] = [NSString stringWithFormat:@"%@ %@", e.name, e.reason];
            }
            if (invoked) {
                actionAttempted = YES;
                if (autoinstallPaymentAuthorizationPromptPendingLocked()) {
                    rec[@"stoppedForPaymentAuthorization"] = @YES;
                    paymentAuthorizationPromptPending = YES;
                }
                [acted addObject:rec];
            }
        });
        if (acted.count > 0 || paymentAuthorizationPromptPending || actionAttempted) break;
    }
    return acted;
}

static NSArray *autoinstallConfirmMatching(NSString *match) {
    if (autoinstallPaymentAuthorizationPromptVisible()) return @[];
    __block NSArray *acted = @[];
    if (!autoinstallRunWithPaymentAuthorizationGuard(^{
        acted = autoinstallConfirmMatchingUnlocked(match);
    })) return @[];
    return acted;
}

static NSArray *autoinstallInviteRoots(void) {
    NSMutableArray *roots = [NSMutableArray array];
    if (gStashedConfirmVC) {
        @try {
            UIView *view = [(id)gStashedConfirmVC view];
            if (view) [roots addObject:view];
        } @catch (NSException *e) {}
    }
    @try {
        for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) continue;
            for (UIWindow *window in [(UIWindowScene *)scene windows]) if (window) [roots addObject:window];
        }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        for (UIWindow *window in [UIApplication sharedApplication].windows) if (window && ![roots containsObject:window]) [roots addObject:window];
#pragma clang diagnostic pop
    } @catch (NSException *e) {}
    return roots;
}

static BOOL autoinstallInviteControlMatches(id element) {
    if (!element || [element isKindOfClass:[UIWindow class]]) return NO;
    NSString *label = @"";
    NSString *title = @"";
    NSString *text = @"";
    @try { if ([element respondsToSelector:@selector(accessibilityLabel)]) label = [element accessibilityLabel] ?: @""; } @catch (NSException *e) {}
    @try { if ([element respondsToSelector:@selector(currentTitle)]) title = [(UIButton *)element currentTitle] ?: @""; } @catch (NSException *e) {}
    @try { if ([element respondsToSelector:@selector(text)]) text = [(UILabel *)element text] ?: @""; } @catch (NSException *e) {}
    for (NSString *value in @[label, title, text]) {
        NSString *normalized = [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if ([normalized caseInsensitiveCompare:@"Accept"] == NSOrderedSame || [normalized caseInsensitiveCompare:@"Join"] == NSOrderedSame) return YES;
    }
    return NO;
}

static NSArray *autoinstallActivateInviteControlsUnlocked(void) {
    NSMutableArray *acted = [NSMutableArray array];
    for (id root in autoinstallInviteRoots()) {
        __block BOOL stopped = NO;
        autoinstallWalkAX(root, ^(id element) {
            if (stopped) return;
            if (autoinstallPaymentAuthorizationPromptPendingLocked()) {
                stopped = YES;
                return;
            }
            if (!autoinstallInviteControlMatches(element)) return;
            @try {
                NSString *label = [element respondsToSelector:@selector(accessibilityLabel)] ? ([element accessibilityLabel] ?: @"") : @"";
                if ([element respondsToSelector:@selector(accessibilityActivate)]) [element accessibilityActivate];
                if (autoinstallPaymentAuthorizationPromptPendingLocked()) {
                    [acted addObject:@{ @"label": label, @"class": NSStringFromClass([element class]) }];
                    stopped = YES;
                    return;
                }
                if ([element isKindOfClass:[UIControl class]]) [(UIControl *)element sendActionsForControlEvents:UIControlEventTouchUpInside];
                [acted addObject:@{ @"label": label, @"class": NSStringFromClass([element class]) }];
                stopped = YES;
            } @catch (NSException *e) {
                [acted addObject:@{ @"class": NSStringFromClass([element class]), @"error": [NSString stringWithFormat:@"%@ %@", e.name, e.reason] }];
                stopped = YES;
            }
        });
        if (acted.count > 0 || autoinstallPaymentAuthorizationPromptPendingLocked()) break;
    }
    return acted;
}

static NSArray *autoinstallActivateInviteControls(void) {
    if (autoinstallPaymentAuthorizationPromptVisible()) return @[];
    __block NSArray *acted = @[];
    if (!autoinstallRunWithPaymentAuthorizationGuard(^{
        acted = autoinstallActivateInviteControlsUnlocked();
    })) return @[];
    return acted;
}

static void autoinstallScheduleInviteControls(NSUInteger attempt) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        NSArray *acted = autoinstallActivateInviteControls();
        autoinstallLog([NSString stringWithFormat:@"subscribe_invite controls attempt=%lu acted=%@", (unsigned long)(attempt + 1), acted]);
        if (acted.count == 0 && attempt < 12) autoinstallScheduleInviteControls(attempt + 1);
    });
}

static void autoinstallScheduleConfirm(NSUInteger attempt) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        NSString *activeMatch = autoinstallAutoConfirmMatchAtPath(kAutoConfirmFlagPath) ?:
                                autoinstallAutoConfirmMatchAtPath(@"/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall-autoconfirm.flag") ?:
                                autoinstallAutoConfirmMatchAtPath(@"/private/var/mobile/Library/Caches/com.apple.PassbookUISceneService/autoinstall-autoconfirm.flag");
        if (!activeMatch) {
            gConfirmAttemptActive = NO;
            return;
        }

        NSArray *acted = autoinstallConfirmMatching(activeMatch);
        autoinstallLog([NSString stringWithFormat:@"auto-confirm match=%@ attempt=%lu acted=%@", activeMatch, (unsigned long)(attempt + 1), acted]);
        if (acted.count > 0) autoinstallClearAutoConfirmFlags();
        if (acted.count > 0 || attempt >= 20) {
            gConfirmDoneThisSheet = acted.count > 0;
            gConfirmAttemptActive = NO;
            return;
        }

        autoinstallScheduleConfirm(attempt + 1);
    });
}

static dispatch_source_t gPassbookBridgeTimer = nil;

static void startPassbookSide(void) {
    autoinstallEnableAX();
    gPassbookBridgeTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(gPassbookBridgeTimer, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), (uint64_t)(0.5 * NSEC_PER_SEC), (uint64_t)(0.1 * NSEC_PER_SEC));
    dispatch_source_set_event_handler(gPassbookBridgeTimer, ^{
        @autoreleasepool {
        autoinstallRefreshPaymentAuthorizationPromptGuard();
        autoinstallTryConfirmFreeAppStoreAuthorization();
        autoinstallHandlePasswordIfPresent();

        if (gConfirmDoneThisSheet) return;
        NSString *match = autoinstallAutoConfirmMatchAtPath(kAutoConfirmFlagPath) ?:
                          autoinstallAutoConfirmMatchAtPath(@"/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall-autoconfirm.flag") ?:
                          autoinstallAutoConfirmMatchAtPath(@"/private/var/mobile/Library/Caches/com.apple.PassbookUISceneService/autoinstall-autoconfirm.flag");
        if (!match) return;
        NSArray *acted = autoinstallConfirmMatching(match);
        if (acted.count > 0) {
            autoinstallLog([NSString stringWithFormat:@"[PB-Timer] auto-confirmed match=%@ acted=%@", match, acted]);
            autoinstallClearAutoConfirmFlags();
            gConfirmDoneThisSheet = YES;
        }
        }
    });
    dispatch_resume(gPassbookBridgeTimer);
    autoinstallLog(@"[PB] timer watcher started");
}

static dispatch_source_t gAuthUIBridgeTimer = nil;

static void startAuthUIServiceSide(void) {
    autoinstallEnableAX();
    gAuthUIBridgeTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(gAuthUIBridgeTimer, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.3 * NSEC_PER_SEC)), (uint64_t)(0.35 * NSEC_PER_SEC), (uint64_t)(0.1 * NSEC_PER_SEC));
    dispatch_source_set_event_handler(gAuthUIBridgeTimer, ^{
        @autoreleasepool {
        autoinstallRefreshPaymentAuthorizationPromptGuard();
        autoinstallHandlePasswordIfPresent();
        NSString *match = autoinstallAutoConfirmMatchAtPath(kAutoConfirmFlagPath) ?:
                          autoinstallAutoConfirmMatchAtPath(@"/private/var/mobile/Library/Caches/com.apple.AuthKitUIService/autoinstall-autoconfirm.flag") ?:
                          autoinstallAutoConfirmMatchAtPath(@"/private/var/mobile/Library/Caches/com.apple.ios.StoreKitUIService/autoinstall-autoconfirm.flag") ?:
                          autoinstallAutoConfirmMatchAtPath(@"/private/var/mobile/Library/Caches/com.apple.CoreAuthUI/autoinstall-autoconfirm.flag") ?:
                          autoinstallAutoConfirmMatchAtPath(@"/private/var/mobile/Library/Caches/com.apple.AccountAuthenticationDialog/autoinstall-autoconfirm.flag");
        if (!match) return;
        NSArray *acted = autoinstallConfirmMatching(match);
        if (acted.count > 0) autoinstallClearAutoConfirmFlags();
        }
    });
    dispatch_resume(gAuthUIBridgeTimer);
    autoinstallLog(@"[AuthUI] timer watcher started");
}

%hook UIViewController

- (void)viewDidAppear:(BOOL)animated {
    %orig;
    if (!gIsPassbookProcess && !gIsAppStoreProcess && !gIsAuthUIService) return;
    @try {
        NSString *cls = NSStringFromClass([self class]);
        autoinstallLog([NSString stringWithFormat:@"viewDidAppear cls=%@ in process=%@", cls, [[NSProcessInfo processInfo] processName]]);
        if ((gIsPassbookProcess || gIsAuthUIService) && autoinstallIsPaymentAuthorizationController(self)) {
            autoinstallMarkPaymentAuthorizationPrompt(self);
            return;
        }
        gStashedConfirmVC = self;
        autoinstallEnableAX();
        autoinstallHandlePasswordIfPresent();
        if (gConfirmDoneThisSheet || gConfirmAttemptActive) return;
        NSString *match = autoinstallAutoConfirmMatchAtPath(kAutoConfirmFlagPath) ?:
                          autoinstallAutoConfirmMatchAtPath(@"/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall-autoconfirm.flag") ?:
                          autoinstallAutoConfirmMatchAtPath(@"/private/var/mobile/Library/Caches/com.apple.PassbookUISceneService/autoinstall-autoconfirm.flag");
        if (!match) return;
        gConfirmAttemptActive = YES;
        autoinstallScheduleConfirm(0);
    } @catch (NSException *e) {}
}

- (void)viewDidDisappear:(BOOL)animated {
    %orig;
    if ((gIsPassbookProcess || gIsAuthUIService) && autoinstallIsPaymentAuthorizationController(self)) {
        autoinstallClearPaymentAuthorizationGuard();
    }
    if (gIsPassbookProcess || gIsAppStoreProcess || gIsAuthUIService) {
        gConfirmDoneThisSheet = NO;
        gConfirmAttemptActive = NO;
    }
}

%end

%hook PKPaymentAuthorizationRemoteAlertViewController

- (void)viewDidAppear:(BOOL)animated {
    %orig;
    if (!gIsPassbookProcess && !gIsAuthUIService) return;
    UIViewController *controller = (UIViewController *)self;
    if (autoinstallIsPaymentAuthorizationController(controller)) autoinstallMarkPaymentAuthorizationPrompt(controller);
}

- (void)viewDidDisappear:(BOOL)animated {
    %orig;
    if ((gIsPassbookProcess || gIsAuthUIService) && autoinstallIsPaymentAuthorizationController((UIViewController *)self)) {
        autoinstallClearPaymentAuthorizationGuard();
    }
}

%end

static NSString * const kASRequestPath = @"/tmp/autoinstall-as-request.json";
static NSString * const kASResponsePath = @"/tmp/autoinstall-as-response.json";
static BOOL appStoreIsForeground(void) {
    return [UIApplication sharedApplication].applicationState == UIApplicationStateActive;
}

static NSDictionary *appStoreBridgeStatus(void) {
    return @{
        @"bridgeVersion": BRIDGE_VERSION,
        @"capabilities": @[@"install", @"status", @"diagnostics", @"foreground_status", @"localized_install_titles", @"protocol_v1", @"authenticated_requests", @"operation_responses", @"heartbeats", @"stale_artifact_cleanup"],
        @"foreground": @(appStoreIsForeground()),
        @"install": readJSONFile(kASInstallStatusPath) ?: @{},
    };
}

static void handleAppStoreRequest(NSDictionary *req, NSString *responsePath, NSString *requestId) {
    void (^respond)(id) = ^(id response) { writeBridgeResponse(responsePath, requestId, response); };
    NSString *action = req[@"action"];
    autoinstallLog([NSString stringWithFormat:@"as-bridge: handling action=%@ req=%@", action, req]);

    if ([action isEqualToString:@"status"]) {
        NSMutableDictionary *response = [appStoreBridgeStatus() mutableCopy];
        response[@"ok"] = @YES;
        respond(response);
        return;
    }

    if ([action isEqualToString:@"diagnostics"]) {
        respond(@{@"ok": @YES, @"data": @{ @"bridge": appStoreBridgeStatus(), @"recentLog": recentBridgeLogEntries() }});
        return;
    }

    if (![action isEqualToString:@"install"]) {
        respond(@{@"ok": @NO, @"error": [NSString stringWithFormat:@"unknown action: %@", action]});
        return;
    }

    NSNumber *adamId = req[@"adamId"];
    NSNumber *versionId = req[@"versionId"];
    NSString *appName = [req[@"appName"] isKindOfClass:[NSString class]] ? req[@"appName"] : nil;
    NSArray *requestedNames = [req[@"appNames"] isKindOfClass:[NSArray class]] ? req[@"appNames"] : nil;
    NSMutableArray<NSString *> *appNames = [NSMutableArray array];
    for (id name in requestedNames) {
        if ([name isKindOfClass:[NSString class]] && [name length] && [name length] <= 200 && ![appNames containsObject:name]) [appNames addObject:name];
    }
    if (!appNames.count && appName.length) [appNames addObject:appName];
    NSNumber *verifiedPrice = [req[@"verifiedPrice"] isKindOfClass:[NSNumber class]] ? req[@"verifiedPrice"] : nil;
    NSString *operationId = [req[@"operationId"] isKindOfClass:[NSString class]] ? req[@"operationId"] : [[NSUUID UUID] UUIDString];
    if (!adamId) {
        respond(@{@"ok": @NO, @"error": @"missing adamId"});
        return;
    }

    NSDictionary *previousStatus = readBridgeTransaction(@"appstore", operationId);
    if ([previousStatus[@"operationId"] isEqual:operationId]) {
        BOOL completed = [previousStatus[@"state"] isEqual:@"completed"];
        respond(@{@"ok": @YES, @"requested": @(!completed), @"resumed": @YES, @"completed": @(completed), @"operationId": operationId});
        return;
    }

    dispatch_sync(dispatch_get_main_queue(), ^{
        @try {
            NSString *adamIdStr = [adamId stringValue];
            NSString *offerString;
            if (versionId && versionId.longLongValue != 0) {
                offerString = [NSString stringWithFormat:@"productType=C&price=0&salableAdamId=%@&pricingParameters=pricingParameter&appExtVrsId=%@&clientBuyId=1&installed=0&trolled=1", adamIdStr, [versionId stringValue]];
            } else {
                offerString = [NSString stringWithFormat:@"productType=C&price=0&salableAdamId=%@&pricingParameters=pricingParameter&clientBuyId=1&installed=0&trolled=1", adamIdStr];
            }

            id<SKUIItemOfferProtocol> offer = [[objc_getClass("SKUIItemOffer") alloc] initWithLookupDictionary:@{@"buyParams": offerString}];
            id<SKUIItemProtocol> item = [[objc_getClass("SKUIItem") alloc] initWithLookupDictionary:@{@"_itemOffer": adamIdStr}];
            if (!offer || !item) {
                respond(@{@"ok": @NO, @"error": @"initWithLookupDictionary: returned nil"});
                return;
            }

            [(id)item setValue:offer forKey:@"_itemOffer"];
            [(id)item setValue:@"iosSoftware" forKey:@"_itemKindString"];
            if (versionId && versionId.longLongValue != 0) {
                [(id)item setValue:versionId forKey:@"_versionIdentifier"];
            }

            Class centerCls = objc_getClass("SKUIItemStateCenter");
            Class contextCls = objc_getClass("SKUIClientContext");
            id<SKUIItemStateCenterProtocol> center = [centerCls defaultCenter];

            id<SKUIClientContextProtocol> clientContext = [contextCls defaultContext];
            if (!clientContext) {
                id fallbackConfig = [contextCls _fallbackConfigurationDictionary];
                clientContext = [[contextCls alloc] initWithConfigurationDictionary:fallbackConfig];
            }
            if (!center || !clientContext) {
                respond(@{@"ok": @NO, @"error": [NSString stringWithFormat:@"center=%@ clientContext=%@", center, clientContext]});
                return;
            }

            id purchases = [center _newPurchasesWithItems:@[(id)item]];
            autoinstallLog([NSString stringWithFormat:@"as-install: adamId=%@ versionId=%@ purchases=%@", adamIdStr, versionId, purchases]);

            void (^completion)(id) = ^(id arg1) {
                NSDictionary *summary = autoinstallPurchaseCompletionSummary(arg1);
                NSError *error = [summary[@"error"] isKindOfClass:[NSError class]] ? summary[@"error"] : nil;
                NSUInteger downloadCount = [summary[@"downloadCount"] unsignedIntegerValue];
                autoinstallLog([NSString stringWithFormat:@"as-install: purchase response classes=%@ errorDomain=%@ errorCode=%ld downloadCount=%lu", summary[@"responseClasses"], error.domain ?: @"none", (long)error.code, (unsigned long)downloadCount]);
                autoinstallClearFreeAppStoreAuthorization(operationId);
                if (error) {
                    NSDictionary *failure = @{
                        @"ok": @NO,
                        @"operationId": operationId,
                        @"state": @"failed",
                        @"error": error.localizedDescription ?: @"The App Store purchase operation failed"
                    };
                    writeBridgeTransaction(@"appstore", operationId, @"failed", failure);
                    writeJSONFile(kASInstallStatusPath, failure);
                    return;
                }
                writeBridgeTransaction(@"appstore", operationId, @"completed", @{@"ok": @YES, @"adamId": adamId, @"versionId": versionId ?: [NSNull null], @"downloadCount": @(downloadCount)});
                writeJSONFile(kASInstallStatusPath, @{@"ok": @YES, @"operationId": operationId, @"state": @"completed", @"adamId": adamId, @"downloadCount": @(downloadCount)});
            };

            writeBridgeTransaction(@"appstore", operationId, @"requested", @{@"ok": @YES, @"adamId": adamId, @"versionId": versionId ?: [NSNull null]});
            writeJSONFile(kASInstallStatusPath, @{@"ok": @YES, @"operationId": operationId, @"state": @"requested", @"adamId": adamId, @"versionId": versionId ?: [NSNull null]});
            writeJSONFile(@"/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall-as-install-status.json", @{@"ok": @YES, @"operationId": operationId, @"state": @"requested", @"adamId": adamId, @"versionId": versionId ?: [NSNull null]});
            writeJSONFile(@"/private/var/mobile/Library/Caches/com.apple.PassbookUISceneService/autoinstall-as-install-status.json", @{@"ok": @YES, @"operationId": operationId, @"state": @"requested", @"adamId": adamId, @"versionId": versionId ?: [NSNull null]});
            if (appNames.count && verifiedPrice && verifiedPrice.doubleValue == 0) {
                NSDictionary *authData = @{@"operationId": operationId, @"appNames": appNames, @"verifiedPrice": verifiedPrice, @"issuedAt": @([NSDate date].timeIntervalSince1970)};
                writeJSONFile(kFreeAppStoreAuthorizationPath, authData);
                writeJSONFile(@"/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall-free-appstore-authorization.json", authData);
                writeJSONFile(@"/private/var/mobile/Library/Caches/com.apple.PassbookUISceneService/autoinstall-free-appstore-authorization.json", authData);
            } else {
                [[NSFileManager defaultManager] removeItemAtPath:kFreeAppStoreAuthorizationPath error:nil];
                [[NSFileManager defaultManager] removeItemAtPath:@"/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall-free-appstore-authorization.json" error:nil];
                [[NSFileManager defaultManager] removeItemAtPath:@"/private/var/mobile/Library/Caches/com.apple.PassbookUISceneService/autoinstall-free-appstore-authorization.json" error:nil];
            }
            [center _performPurchases:purchases hasBundlePurchase:NO withClientContext:(id)clientContext completionBlock:completion];
            respond(@{@"ok": @YES, @"requested": @YES, @"operationId": operationId});
        } @catch (NSException *exception) {
            autoinstallClearFreeAppStoreAuthorization(operationId);
            autoinstallLog([NSString stringWithFormat:@"as-install: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
            respond(@{@"ok": @NO, @"error": [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason]});
        }
    });
}

static dispatch_queue_t gASBridgeQueue = nil;
static dispatch_source_t gASBridgeTimer = nil;

static void startAppStoreSide(void) {
    autoinstallEnableAX();
    gASBridgeQueue = dispatch_queue_create("dev.adrian.autoinstall.as-bridge", DISPATCH_QUEUE_SERIAL);
    gASBridgeTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gASBridgeQueue);
    dispatch_source_set_timer(gASBridgeTimer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_MSEC * 200);
    dispatch_source_set_event_handler(gASBridgeTimer, ^{
        @autoreleasepool {
        NSFileManager *fm = [NSFileManager defaultManager];
        writeBridgeHeartbeat(@"appstore");
        sweepBridgeArtifacts(@"appstore");
        processSecureBridgeRequests(@"appstore", ^(NSDictionary *request, NSString *responsePath, NSString *requestId) {
            handleAppStoreRequest(request, responsePath, requestId);
        });

        dispatch_async(dispatch_get_main_queue(), ^{
            autoinstallHandlePasswordIfPresent();
        });

        NSString *autoConfirmMatch = autoinstallAutoConfirmMatchAtPath(kAutoConfirmFlagPath);
        if (autoConfirmMatch) {
            dispatch_async(dispatch_get_main_queue(), ^{
                NSString *match = autoinstallAutoConfirmMatchAtPath(kAutoConfirmFlagPath);
                if (!match) return;
                NSArray *acted = autoinstallConfirmMatching(match);
                if (acted.count > 0) {
                    autoinstallLog([NSString stringWithFormat:@"[AS] auto-confirmed match=%@ acted=%@", match, acted]);
                    autoinstallClearAutoConfirmFlags();
                }
            });
        }

        if (![fm fileExistsAtPath:kASRequestPath]) return;

        NSData *data = [NSData dataWithContentsOfFile:kASRequestPath];
        [fm removeItemAtPath:kASRequestPath error:nil];
        if (!data) return;

        NSError *err = nil;
        NSDictionary *req = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
        if (!req) {
            autoinstallLog([NSString stringWithFormat:@"as-bridge: bad request json: %@", err]);
            return;
        }
        rejectLegacyBridgeRequest(req, kASResponsePath);
        }
    });
    dispatch_resume(gASBridgeTimer);
    autoinstallLog(@"as-bridge: request-file watcher started");
}

%ctor {
    NSString *bundleId = [[NSBundle mainBundle] bundleIdentifier];
    NSString *processName = [[NSProcessInfo processInfo] processName];
    autoinstallLog([NSString stringWithFormat:@"autoinstall loaded into pid %d bundle %@ process %@",
        [[NSProcessInfo processInfo] processIdentifier], bundleId, processName]);

    if (isSpringBoard()) {
        startSpringBoardSide();
    } else if ([bundleId isEqualToString:@"com.apple.AppStore"]) {
        gIsAppStoreProcess = YES;
        autoinstallEnableAX();
        startAppStoreSide();
    } else if ([bundleId isEqualToString:@"com.apple.PassbookUIService"] || [processName isEqualToString:@"PassbookUIService"] ||
               [bundleId isEqualToString:@"com.apple.PassbookSecureUIService"] || [processName isEqualToString:@"PassbookSecureUIService"] ||
               [bundleId isEqualToString:@"com.apple.PassbookUISceneService"] || [processName isEqualToString:@"PassbookUISceneService"]) {
        gIsPassbookProcess = YES;
        autoinstallEnableAX();
        startPassbookSide();
    } else if ([bundleId isEqualToString:@"com.apple.AuthKitUIService"] || [processName isEqualToString:@"AuthKitUIService"] ||
               [bundleId isEqualToString:@"com.apple.ios.StoreKitUIService"] || [processName isEqualToString:@"StoreKitUIService"] ||
               [bundleId isEqualToString:@"com.apple.AppleIDSetupUIService"] || [processName isEqualToString:@"AppleIDSetupUIService"] ||
               [bundleId isEqualToString:@"com.apple.CoreAuthUI"] || [processName isEqualToString:@"CoreAuthUI"] ||
               [bundleId isEqualToString:@"com.apple.AccountAuthenticationDialog"] || [processName isEqualToString:@"AccountAuthenticationDialog"]) {
        gIsAuthUIService = YES;
        autoinstallEnableAX();
        startAuthUIServiceSide();
    } else {
        startTestFlightSide();
    }
}
