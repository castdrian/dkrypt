#import <Foundation/Foundation.h>

// Private API research: https://github.com/appknox/appstorectl (MIT).
// Keep validation independent of private frameworks so it can be tested on macOS.
static inline BOOL AIIdentifier(NSString *value, NSString *characters, NSUInteger limit) {
    return [value isKindOfClass:NSString.class] && value.length > 0 && value.length <= limit &&
        [value rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:characters] invertedSet]].location == NSNotFound;
}

static inline BOOL AIValidInstallRequest(NSDictionary *request) {
    id price = request[@"verifiedPrice"];
    NSString *version = request[@"versionId"];
    return AIIdentifier(request[@"bundleId"], @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-", 200) &&
        AIIdentifier(request[@"adamId"], @"0123456789", 20) && [request[@"adamId"] longLongValue] > 0 &&
        AIIdentifier(request[@"operationId"], @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.", 160) &&
        [price isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)price) != CFBooleanGetTypeID() && [price doubleValue] == 0 &&
        (!version || (AIIdentifier(version, @"0123456789", 20) && [version longLongValue] > 0));
}

static inline NSDictionary *AIStoreError(NSError *error) {
    NSMutableDictionary *result = [NSMutableDictionary dictionary];
    NSMutableArray *chain = [NSMutableArray array];
    NSString *dialogID = nil;
    NSString *kind = nil;
    for (NSUInteger depth = 0; [error isKindOfClass:NSError.class] && depth < 5; depth++) {
        // Never serialize userInfo: it can include account details and replay parameters.
        [chain addObject:@{@"domain": error.domain ?: @"unknown", @"code": @(error.code)}];
        id payload = error.userInfo[@"AMSServerPayload"];
        id dialog = [payload isKindOfClass:NSDictionary.class] ? payload[@"dialog"] : nil;
        if ([dialog isKindOfClass:NSDictionary.class]) {
            if ([dialog[@"dialogId"] isKindOfClass:NSString.class]) dialogID = dialog[@"dialogId"];
            if ([dialog[@"kind"] isKindOfClass:NSString.class]) kind = dialog[@"kind"];
        }
        if ([payload isKindOfClass:NSDictionary.class] && [payload[@"dialogId"] isKindOfClass:NSString.class]) dialogID = payload[@"dialogId"];
        error = error.userInfo[NSUnderlyingErrorKey];
    }
    result[@"chain"] = chain;
    if (dialogID) result[@"dialogId"] = [dialogID substringToIndex:MIN(dialogID.length, 160)];
    BOOL authorization = [kind isEqual:@"authorization"] || [dialogID hasSuffix:@".Auth"] || [dialogID containsString:@"SignatureRequired"];
    result[@"category"] = authorization ? @"authorization_required" : @"purchase_failed";
    result[@"message"] = authorization ? @"App Store authorization requires action on the device" : @"App Store purchase failed";
    result[@"retryable"] = @NO;
    return result;
}

static inline BOOL AIRegularNonemptyFile(NSString *path) {
    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:path error:nil];
    return [attributes[NSFileType] isEqual:NSFileTypeRegular] && [attributes[NSFileSize] unsignedLongLongValue] > 0;
}

static inline BOOL AIInstalledBundleReady(NSString *path, NSString *bundleID) {
    NSDictionary *info = [NSDictionary dictionaryWithContentsOfFile:[path stringByAppendingPathComponent:@"Info.plist"]];
    if (![info[@"CFBundleIdentifier"] isEqual:bundleID]) return NO;
    NSString *executable = info[@"CFBundleExecutable"];
    if (![executable isKindOfClass:NSString.class] || !executable.length || ![executable.lastPathComponent isEqual:executable] || !AIRegularNonemptyFile([path stringByAppendingPathComponent:executable])) return NO;
    NSDictionary *manifest = [NSDictionary dictionaryWithContentsOfFile:[path stringByAppendingPathComponent:@"SC_Info/Manifest.plist"]];
    NSMutableSet *licenses = [NSMutableSet set];
    for (NSString *key in @[@"SinfPaths", @"SinfReplicationPaths"]) {
        id paths = manifest[key];
        if (paths && ![paths isKindOfClass:NSArray.class]) return NO;
        for (id relative in paths) {
            if (![relative isKindOfClass:NSString.class] || ![relative length] || [relative isAbsolutePath] || [[relative pathComponents] containsObject:@".."] || ![@[@"sinf", @"supf"] containsObject:[relative pathExtension]]) return NO;
            [licenses addObject:relative];
        }
    }
    if (licenses.count) {
        NSString *root = [path.stringByResolvingSymlinksInPath stringByAppendingString:@"/"];
        for (NSString *relative in licenses) {
            NSString *license = [[path stringByAppendingPathComponent:relative] stringByResolvingSymlinksInPath];
            if (![license hasPrefix:root] || !AIRegularNonemptyFile(license)) return NO;
        }
        return YES;
    }
    // Newer store payloads can use SUPF or versioned SINF names.
    NSString *scInfo = [path stringByAppendingPathComponent:@"SC_Info"];
    for (NSString *name in [NSFileManager.defaultManager contentsOfDirectoryAtPath:scInfo error:nil]) {
        BOOL matches = [name isEqual:[executable stringByAppendingString:@".sinf"]] || [name isEqual:[executable stringByAppendingString:@".supf"]] ||
            ([name hasPrefix:[executable stringByAppendingString:@"."]] && [@[@"sinf", @"supf"] containsObject:name.pathExtension]);
        if (matches && AIRegularNonemptyFile([scInfo stringByAppendingPathComponent:name])) return YES;
    }
    return NO;
}
