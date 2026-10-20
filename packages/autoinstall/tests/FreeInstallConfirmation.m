#import <Foundation/Foundation.h>
#import "../sources/FreeInstallConfirmation.h"

static void expect(BOOL value, NSString *message) {
    if (!value) {
        NSLog(@"%@", message);
        exit(1);
    }
}

int main(void) {
    @autoreleasepool {
        NSArray *labels = @[@"App Store", @"Discord – Talk, Play, Hang Out", @"Offers In-App Purchases"];
        NSArray *buttons = @[@"Install"];
        expect(autoinstallCanConfirmFreeInstall(@"Discord - Talk, Play, Hang Out", labels, buttons, @0, 2), @"free matching install should be confirmed");
        expect(autoinstallCanConfirmFreeInstall(@"Discord - Talk, Play, Hang Out", @[@"App Store confirmation", @"Discord – Talk, Play, Hang Out Offers In-App Purchases"], buttons, @0, 2), @"combined accessibility labels should be confirmed");
        expect(!autoinstallCanConfirmFreeInstall(@"Discord - Talk, Play, Hang Out", @[@"App Storefront", @"Discord – Talk, Play, Hang Out Offers In-App Purchases"], buttons, @0, 2), @"partial App Store heading must remain blocked");
        expect(!autoinstallCanConfirmFreeInstall(@"Discord - Talk, Play, Hang Out", @[@"App Store confirmation", @"Discord – Talk, Play, Hang Outs"], buttons, @0, 2), @"partial app title must remain blocked");
        expect(!autoinstallCanConfirmFreeInstall(@"Other App", labels, buttons, @0, 2), @"different app must remain blocked");
        expect(!autoinstallCanConfirmFreeInstall(@"Discord - Talk, Play, Hang Out", labels, buttons, @1, 2), @"paid app must remain blocked");
        expect(!autoinstallCanConfirmFreeInstall(@"Discord - Talk, Play, Hang Out", labels, buttons, @0, 121), @"stale request must remain blocked");
        expect(!autoinstallCanConfirmFreeInstall(@"Discord - Talk, Play, Hang Out", @[@"App Store", @"Other App"], buttons, @0, 2), @"sheet identity must match");
        expect(!autoinstallCanConfirmFreeInstall(@"Discord - Talk, Play, Hang Out", @[@"App Store", @"Discord – Talk, Play, Hang Out", @"€4.99"], buttons, @0, 2), @"priced sheet must remain blocked");
        expect(!autoinstallCanConfirmFreeInstall(@"Discord - Talk, Play, Hang Out", labels, @[@"Buy"], @0, 2), @"buy control must remain blocked");
        expect(autoinstallCanConfirmFreeInstallForNames(@[@"Cleanup: Phone Storage Cleaner", @"Cleanup: Clean Storage Space"], @[@"App Store", @"Cleanup: Clean Storage Space"], buttons, @0, 2), @"verified localized title should be confirmed");
        expect(!autoinstallCanConfirmFreeInstallForNames(@[@"Cleanup: Phone Storage Cleaner", @"Cleanup: Clean Storage Space"], @[@"App Store", @"Unrelated Cleaner"], buttons, @0, 2), @"different localized app must remain blocked");
    }
    return 0;
}
