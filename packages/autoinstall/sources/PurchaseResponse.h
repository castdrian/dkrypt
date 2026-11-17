#import <Foundation/Foundation.h>
#import "../appstore/InstallSupport.h"

@protocol AutoinstallPurchaseResponseProtocol <NSObject>
@optional
- (NSError *)error;
- (NSArray *)downloadIdentifiers;
@end

static NSDictionary *autoinstallPurchaseCompletionSummary(id value) {
    NSArray *responses = [value isKindOfClass:[NSArray class]] ? value : (value ? @[value] : @[]);
    NSMutableArray<NSString *> *responseClasses = [NSMutableArray arrayWithCapacity:responses.count];
    NSError *error = nil;
    NSUInteger downloadCount = 0;
    for (id response in responses) {
        [responseClasses addObject:NSStringFromClass([response class]) ?: @"unknown"];
        if ([response isKindOfClass:[NSError class]]) {
            if (!error) error = response;
            continue;
        }
        if ([response respondsToSelector:@selector(error)]) {
            id responseError = [(id<AutoinstallPurchaseResponseProtocol>)response error];
            if (!error && [responseError isKindOfClass:[NSError class]]) error = responseError;
        }
        if ([response respondsToSelector:@selector(downloadIdentifiers)]) {
            id identifiers = [(id<AutoinstallPurchaseResponseProtocol>)response downloadIdentifiers];
            if ([identifiers isKindOfClass:[NSArray class]]) downloadCount += [(NSArray *)identifiers count];
        }
    }
    if (!responses.count) error = [NSError errorWithDomain:@"AutoinstallPurchase" code:1 userInfo:@{NSLocalizedDescriptionKey: @"App Store returned no purchase responses"}];
    return @{@"error": error ?: [NSNull null], @"downloadCount": @(downloadCount), @"responseClasses": responseClasses};
}
