#import <Foundation/Foundation.h>

static NSString *autoinstallCanonicalAppName(NSString *value) {
    NSMutableString *canonical = [NSMutableString string];
    NSCharacterSet *lettersAndDigits = [NSCharacterSet alphanumericCharacterSet];
    BOOL previousWasSeparator = NO;
    for (NSUInteger index = 0; index < value.length; index++) {
        unichar character = [value characterAtIndex:index];
        if ([lettersAndDigits characterIsMember:character]) {
            [canonical appendFormat:@"%C", character];
            previousWasSeparator = NO;
        } else if (canonical.length && !previousWasSeparator) {
            [canonical appendString:@" "];
            previousWasSeparator = YES;
        }
    }
    return [[canonical stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] lowercaseString];
}

static BOOL autoinstallLabelContainsCanonicalPhrase(NSString *label, NSString *phrase) {
    NSString *canonicalLabel = autoinstallCanonicalAppName(label);
    if (!phrase.length || !canonicalLabel.length) return NO;
    NSString *boundedLabel = [NSString stringWithFormat:@" %@ ", canonicalLabel];
    NSString *boundedPhrase = [NSString stringWithFormat:@" %@ ", phrase];
    return [boundedLabel rangeOfString:boundedPhrase].location != NSNotFound;
}

static BOOL autoinstallCanConfirmFreeInstallForNames(NSArray<NSString *> *appNames, NSArray<NSString *> *labels, NSArray<NSString *> *buttons, NSNumber *price, NSTimeInterval ageSeconds) {
    if (!appNames.count || ![price isKindOfClass:[NSNumber class]] || price.doubleValue != 0 || ageSeconds < 0 || ageSeconds > 120) return NO;
    BOOL appStoreHeadingFound = NO;
    BOOL appNameFound = NO;
    for (NSString *label in labels) {
        if (![label isKindOfClass:[NSString class]]) continue;
        if (autoinstallLabelContainsCanonicalPhrase(label, @"app store")) appStoreHeadingFound = YES;
        for (NSString *appName in appNames) {
            if (![appName isKindOfClass:[NSString class]]) continue;
            NSString *expectedName = autoinstallCanonicalAppName(appName);
            if (autoinstallLabelContainsCanonicalPhrase(label, expectedName)) appNameFound = YES;
        }
        if ([label rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"€$£¥₹₩"]].location != NSNotFound) return NO;
    }
    BOOL installButtonFound = NO;
    for (NSString *button in buttons) {
        if (![button isKindOfClass:[NSString class]]) continue;
        NSString *title = [button stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if ([title caseInsensitiveCompare:@"Install"] == NSOrderedSame || [title caseInsensitiveCompare:@"Installieren"] == NSOrderedSame) installButtonFound = YES;
    }
    return appStoreHeadingFound && appNameFound && installButtonFound;
}

static BOOL autoinstallCanConfirmFreeInstall(NSString *appName, NSArray<NSString *> *labels, NSArray<NSString *> *buttons, NSNumber *price, NSTimeInterval ageSeconds) {
    return autoinstallCanConfirmFreeInstallForNames(appName.length ? @[appName] : @[], labels, buttons, price, ageSeconds);
}
