#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <Preferences/PSListController.h>
#import <Preferences/PSSpecifier.h>
#import <arpa/inet.h>
#import <netinet/in.h>
#import <sys/socket.h>
#import <unistd.h>

static NSString * const kPreferencesDomain = @"dev.adrian.autoinstall";
static NSString * const kBridgeRoot = @"/tmp/autoinstall/v1";
static NSString * const kActivityPath = @"/var/mobile/Library/Preferences/dev.adrian.autoinstall-recent-activity.json";
static NSString * const kDarkFlagPath = @"/var/mobile/Library/Preferences/dev.adrian.autoinstall-dark.flag";

@interface AutoinstallRootListController : PSListController
@end

@implementation AutoinstallRootListController

- (id)preferenceValue:(PSSpecifier *)specifier {
    NSString *key = [specifier propertyForKey:@"key"];
    id fallback = [specifier propertyForKey:@"default"];
    id value = CFBridgingRelease(CFPreferencesCopyAppValue((__bridge CFStringRef)key, (__bridge CFStringRef)kPreferencesDomain));
    if (!value && [key isEqual:@"DisplayMode"] && [[NSFileManager defaultManager] fileExistsAtPath:kDarkFlagPath]) return @"dark_awake";
    return value ?: fallback;
}

- (void)setPreferenceValue:(id)value specifier:(PSSpecifier *)specifier {
    NSString *key = [specifier propertyForKey:@"key"];
    CFPreferencesSetAppValue((__bridge CFStringRef)key, (__bridge CFPropertyListRef)value, (__bridge CFStringRef)kPreferencesDomain);
    CFPreferencesAppSynchronize((__bridge CFStringRef)kPreferencesDomain);
}

- (NSString *)versionValue:(PSSpecifier *)specifier {
    return AUTOINSTALL_PREFS_VERSION;
}

- (BOOL)isHeartbeatFresh:(NSString *)channel {
    NSString *path = [NSString stringWithFormat:@"%@/%@/state/heartbeat.json", kBridgeRoot, channel];
    NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
    NSDate *modifiedAt = attributes[NSFileModificationDate];
    return modifiedAt && -modifiedAt.timeIntervalSinceNow < 90;
}

- (NSString *)springboardValue:(PSSpecifier *)specifier {
    return [self isHeartbeatFresh:@"springboard"] ? @"Connected" : @"Not responding";
}

- (BOOL)isAgentListening {
    int descriptor = socket(AF_INET, SOCK_STREAM, 0);
    if (descriptor < 0) return NO;
    struct timeval timeout = {1, 0};
    setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    struct sockaddr_in address = {0};
    address.sin_len = sizeof(address);
    address.sin_family = AF_INET;
    address.sin_port = htons(5913);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    BOOL listening = connect(descriptor, (struct sockaddr *)&address, sizeof(address)) == 0;
    close(descriptor);
    return listening;
}

- (NSString *)agentValue:(PSSpecifier *)specifier {
    return [self isAgentListening] ? @"Connected" : @"Not responding";
}

- (NSString *)operationValue:(PSSpecifier *)specifier {
    NSTimeInterval now = NSDate.date.timeIntervalSince1970;
    NSString *latestName;
    NSTimeInterval latestAt = 0;
    for (NSString *channel in @[@"appstore", @"testflight"]) {
        NSString *directory = [NSString stringWithFormat:@"%@/%@/transactions", kBridgeRoot, channel];
        for (NSString *name in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:directory error:nil] ?: @[]) {
            if (![name.pathExtension isEqualToString:@"json"]) continue;
            NSString *path = [directory stringByAppendingPathComponent:name];
            NSData *data = [NSData dataWithContentsOfFile:path];
            NSDictionary *transaction = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
            NSString *state = transaction[@"state"];
            NSTimeInterval updatedAt = [transaction[@"updatedAt"] doubleValue];
            if ((![state isEqual:@"requested"] && ![state isEqual:@"authorizing"] && ![state isEqual:@"installing"]) || now - updatedAt > 1800 || updatedAt <= latestAt) continue;
            latestAt = updatedAt;
            latestName = [transaction[@"bundleId"] isKindOfClass:[NSString class]] ? transaction[@"bundleId"] : channel;
        }
    }
    return latestName ?: @"Nothing running";
}

- (NSString *)activityDate:(PSSpecifier *)specifier {
    NSDictionary *entry = [specifier propertyForKey:@"activity"];
    NSTimeInterval timestamp = [entry[@"at"] doubleValue];
    if (timestamp <= 0) return @"";
    NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
    formatter.dateStyle = NSDateFormatterShortStyle;
    formatter.timeStyle = NSDateFormatterShortStyle;
    return [formatter stringFromDate:[NSDate dateWithTimeIntervalSince1970:timestamp]];
}

- (PSSpecifier *)valueSpecifier:(NSString *)title getter:(SEL)getter {
    PSSpecifier *specifier = [PSSpecifier preferenceSpecifierNamed:title target:self set:nil get:getter detail:nil cell:PSTitleValueCell edit:nil];
    return specifier;
}

- (PSSpecifier *)switchSpecifier:(NSString *)title key:(NSString *)key defaultValue:(BOOL)defaultValue {
    PSSpecifier *specifier = [PSSpecifier preferenceSpecifierNamed:title target:self set:@selector(setPreferenceValue:specifier:) get:@selector(preferenceValue:) detail:nil cell:PSSwitchCell edit:nil];
    [specifier setProperty:key forKey:@"key"];
    [specifier setProperty:kPreferencesDomain forKey:@"defaults"];
    [specifier setProperty:@(defaultValue) forKey:@"default"];
    return specifier;
}

- (PSSpecifier *)listSpecifier:(NSString *)title key:(NSString *)key values:(NSArray *)values titles:(NSArray *)titles defaultValue:(id)defaultValue footer:(NSString *)footer {
    PSSpecifier *specifier = [PSSpecifier preferenceSpecifierNamed:title target:self set:@selector(setPreferenceValue:specifier:) get:@selector(preferenceValue:) detail:nil cell:PSLinkListCell edit:nil];
    [specifier setProperty:key forKey:@"key"];
    [specifier setProperty:kPreferencesDomain forKey:@"defaults"];
    [specifier setProperty:values forKey:@"validValues"];
    [specifier setProperty:titles forKey:@"validTitles"];
    [specifier setProperty:defaultValue forKey:@"default"];
    [specifier setProperty:footer forKey:@"footerText"];
    return specifier;
}

- (NSMutableArray *)specifiers {
    if (_specifiers) return _specifiers;
    NSMutableArray *items = [NSMutableArray array];
    [items addObject:[PSSpecifier groupSpecifierWithName:@"Status"]];
    [items addObject:[self valueSpecifier:@"Package version" getter:@selector(versionValue:)]];
    [items addObject:[self valueSpecifier:@"SpringBoard bridge" getter:@selector(springboardValue:)]];
    [items addObject:[self valueSpecifier:@"USB device agent" getter:@selector(agentValue:)]];
    [items addObject:[self valueSpecifier:@"Current operation" getter:@selector(operationValue:)]];

    [items addObject:[PSSpecifier groupSpecifierWithName:@"Work"]];
    [items addObject:[self switchSpecifier:@"Pause new installs" key:@"Paused" defaultValue:NO]];

    [items addObject:[PSSpecifier groupSpecifierWithName:@"Display"]];
    [items addObject:[self listSpecifier:@"Screen behavior" key:@"DisplayMode" values:@[@"dark_awake", @"dark_sleep", @"restore_idle", @"unchanged"] titles:@[@"Dark and keep awake", @"Dark and allow auto-lock", @"Dark while working", @"Leave unchanged"] defaultValue:@"unchanged" footer:@"The original brightness is saved before dimming and restored when the display returns to its idle state."]];

    [items addObject:[PSSpecifier groupSpecifierWithName:@"Battery"]];
    [items addObject:[self switchSpecifier:@"Pause when battery is low" key:@"PauseOnLowBattery" defaultValue:NO]];
    [items addObject:[self listSpecifier:@"Pause below" key:@"LowBatteryThreshold" values:@[@10, @15, @20, @25, @30, @40] titles:@[@"10%", @"15%", @"20%", @"25%", @"30%", @"40%"] defaultValue:@20 footer:@"New installs wait until the iPad is charging or above this level. Running work is not interrupted."]];

    [items addObject:[PSSpecifier groupSpecifierWithName:@"Self-check and recent activity"]];
    PSSpecifier *check = [PSSpecifier preferenceSpecifierNamed:@"Run self-check" target:self set:nil get:nil detail:nil cell:PSButtonCell edit:nil];
    check.buttonAction = @selector(runSelfCheck:);
    [items addObject:check];
    NSData *activityData = [NSData dataWithContentsOfFile:kActivityPath];
    NSArray *activity = activityData ? [NSJSONSerialization JSONObjectWithData:activityData options:0 error:nil] : nil;
    for (NSDictionary *entry in [[activity reverseObjectEnumerator] allObjects] ?: @[]) {
        NSString *subject = entry[@"bundleId"] ?: entry[@"channel"] ?: @"Autoinstall";
        NSString *state = entry[@"state"] ?: @"updated";
        PSSpecifier *row = [self valueSpecifier:[NSString stringWithFormat:@"%@ · %@", subject, state] getter:@selector(activityDate:)];
        [row setProperty:entry forKey:@"activity"];
        [items addObject:row];
    }
    if (activity.count == 0) [items addObject:[PSSpecifier preferenceSpecifierNamed:@"No recent operations" target:nil set:nil get:nil detail:nil cell:PSStaticTextCell edit:nil]];
    _specifiers = items;
    return _specifiers;
}

- (void)runSelfCheck:(PSSpecifier *)specifier {
    BOOL springboard = [self isHeartbeatFresh:@"springboard"];
    BOOL agent = [self isAgentListening];
    NSString *result = [NSString stringWithFormat:@"SpringBoard bridge: %@\nUSB device agent: %@\nRecent activity: %@", springboard ? @"Connected" : @"Not responding", agent ? @"Connected" : @"Not responding", [self operationValue:nil]];
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Autoinstall self-check" message:result preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"Done" style:UIAlertActionStyleDefault handler:nil]];
    [self presentViewController:alert animated:YES completion:nil];
    [self reloadSpecifiers];
}

- (void)viewWillAppear:(BOOL)animated {
    [super viewWillAppear:animated];
    _specifiers = nil;
    [self reloadSpecifiers];
}

@end
