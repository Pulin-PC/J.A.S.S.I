// Dev only: a tiny window with one ordinary text box and one password box, to test safety rule 2
// (docs/native-contract.md §4) without going near a real password.
//
//   clang -fobjc-arc -framework Cocoa -o /tmp/jassi-secure-test apps/desktop/dev/secure-test.m && /tmp/jassi-secure-test
#import <Cocoa/Cocoa.h>

int main(void) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSWindow *win = [[NSWindow alloc] initWithContentRect:NSMakeRect(300, 400, 360, 150)
                                                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
    win.title = @"J.A.S.S.I secure field test";
    NSTextField *plain = [[NSTextField alloc] initWithFrame:NSMakeRect(20, 90, 320, 24)];
    plain.placeholderString = @"Name";
    plain.stringValue = @"plain text";
    NSSecureTextField *secret = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(20, 50, 320, 24)];
    secret.placeholderString = @"Password";
    secret.stringValue = @"hunter2-secret";
    [win.contentView addSubview:plain];
    [win.contentView addSubview:secret];
    [win makeKeyAndOrderFront:nil];
    [win makeFirstResponder:plain];
    [app activateIgnoringOtherApps:YES];
    [app run];
  }
  return 0;
}
