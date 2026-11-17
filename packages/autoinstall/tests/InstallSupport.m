#import <Foundation/Foundation.h>
#import "../appstore/InstallSupport.h"

static void expect(BOOL condition, NSString *message) {
    if (!condition) { NSLog(@"%@", message); exit(1); }
}

int main(void) {
    @autoreleasepool {
        NSDictionary *valid = @{@"bundleId": @"com.example.app", @"adamId": @"123", @"verifiedPrice": @0, @"operationId": @"test-op", @"versionId": @"456"};
        expect(AIValidInstallRequest(valid), @"valid verified-free request");
        for (NSDictionary *override in @[@{@"verifiedPrice": @YES}, @{@"verifiedPrice": @NO}, @{@"verifiedPrice": @1}, @{@"verifiedPrice": @"0"}, @{@"operationId": @"../escape"}, @{@"bundleId": @"bad';id"}, @{@"versionId": @"0"}]) {
            NSMutableDictionary *request = valid.mutableCopy;
            [request addEntriesFromDictionary:override];
            expect(!AIValidInstallRequest(request), @"reject invalid purchase request");
        }
        NSError *inner = [NSError errorWithDomain:@"AMSErrorDomain" code:305 userInfo:@{@"AMSServerPayload": @{@"dialog": @{@"dialogId": @"MZCommerce.ConfirmPaymentSheet.Auth", @"kind": @"authorization", @"okButtonAction": @{@"buyParams": @"SECRET"}}}}];
        NSError *outer = [NSError errorWithDomain:@"ASDErrorDomain" code:500 userInfo:@{NSUnderlyingErrorKey: inner, NSLocalizedDescriptionKey: @"SECRET"}];
        NSDictionary *details = AIStoreError(outer);
        expect([details[@"category"] isEqual:@"authorization_required"], @"classify nested authorization error");
        expect([details[@"chain"] count] == 2, @"retain error codes");
        expect(![details.description containsString:@"SECRET"], @"exclude account and replay payloads");

        NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
        NSString *app = [root stringByAppendingPathComponent:@"DifferentName.app"];
        NSString *scInfo = [app stringByAppendingPathComponent:@"SC_Info"];
        [NSFileManager.defaultManager createDirectoryAtPath:scInfo withIntermediateDirectories:YES attributes:nil error:nil];
        [@{@"CFBundleIdentifier": @"com.example.app", @"CFBundleExecutable": @"ActualExecutable"} writeToFile:[app stringByAppendingPathComponent:@"Info.plist"] atomically:YES];
        NSString *executable = [app stringByAppendingPathComponent:@"ActualExecutable"];
        [@"binary" writeToFile:executable atomically:YES encoding:NSUTF8StringEncoding error:nil];
        expect(!AIInstalledBundleReady(app, @"com.example.app"), @"empty SC_Info is not installed");
        NSString *license = [scInfo stringByAppendingPathComponent:@"ActualExecutable.v5.supf"];
        [@"license" writeToFile:license atomically:YES encoding:NSUTF8StringEncoding error:nil];
        expect(AIInstalledBundleReady(app, @"com.example.app"), @"versioned SUPF with actual executable name");
        expect(!AIInstalledBundleReady(app, @"com.example"), @"exact bundle identifier");
        NSString *manifest = [scInfo stringByAppendingPathComponent:@"Manifest.plist"];
        [@{@"SinfPaths": @[@"SC_Info/ActualExecutable.v5.supf"], @"SinfReplicationPaths": @[@"PlugIns/Share.appex/SC_Info/Share.sinf"]} writeToFile:manifest atomically:YES];
        expect(!AIInstalledBundleReady(app, @"com.example.app"), @"missing replicated extension license must fail");
        NSString *extensionLicense = [app stringByAppendingPathComponent:@"PlugIns/Share.appex/SC_Info/Share.sinf"];
        [NSFileManager.defaultManager createDirectoryAtPath:extensionLicense.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
        [@"license" writeToFile:extensionLicense atomically:YES encoding:NSUTF8StringEncoding error:nil];
        expect(AIInstalledBundleReady(app, @"com.example.app"), @"all declared licenses exist");
        [@{@"SinfPaths": @[@"../outside.sinf"]} writeToFile:manifest atomically:YES];
        expect(!AIInstalledBundleReady(app, @"com.example.app"), @"reject license path traversal");
        [NSFileManager.defaultManager removeItemAtPath:manifest error:nil];
        [NSFileManager.defaultManager removeItemAtPath:executable error:nil];
        expect(!AIInstalledBundleReady(app, @"com.example.app"), @"missing executable must fail");
        [NSFileManager.defaultManager removeItemAtPath:root error:nil];
    }
    return 0;
}
