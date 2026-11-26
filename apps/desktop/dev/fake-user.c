// Dev only: stands in for a person during tests of safety rule 4 (docs/native-contract.md §4).
//
//   clang -framework ApplicationServices -o /tmp/fake-user apps/desktop/dev/fake-user.c
//   fake-user move            nudge the mouse 2 px and back, as hardware-level events ("the user moved the mouse")
//   fake-user hotkey          press Control + Option + Esc (the stop shortcut)
//   fake-user windows <pid>   list that app's windows that are on screen right now (is the banner up?)
//   fake-user stop <pid>      press the banner's Stop button
//   fake-user press <pid> <t> press the button called <t> in one of that app's windows
//   fake-user texts <pid>     print the text that app's windows show (to check the native screens)
//   fake-user idle            seconds since the real mouse or keyboard was last used
//   fake-user front <pid>     bring that app to the front
//
// Needs the Accessibility permission (it inherits the terminal's).
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void post_move(double dx) {
  CGEventRef now = CGEventCreate(NULL);
  CGPoint p = CGEventGetLocation(now);
  CFRelease(now);
  p.x += dx;
  CGEventRef ev = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, p, kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
}

static void post_key(CGKeyCode code, CGEventFlags flags, bool down) {
  CGEventRef ev = CGEventCreateKeyboardEvent(NULL, code, down);
  CGEventSetFlags(ev, flags);
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
}

static void list_windows(pid_t pid) {
  CFArrayRef all = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  int shown = 0;
  for (CFIndex i = 0; all && i < CFArrayGetCount(all); i++) {
    CFDictionaryRef w = CFArrayGetValueAtIndex(all, i);
    int owner = 0, layer = 0;
    CFNumberGetValue(CFDictionaryGetValue(w, kCGWindowOwnerPID), kCFNumberIntType, &owner);
    if (owner != pid) continue;
    CFNumberGetValue(CFDictionaryGetValue(w, kCGWindowLayer), kCFNumberIntType, &layer);
    CGRect r;
    CGRectMakeWithDictionaryRepresentation(CFDictionaryGetValue(w, kCGWindowBounds), &r);
    printf("on screen: %.0fx%.0f at (%.0f,%.0f) layer %d%s\n", r.size.width, r.size.height, r.origin.x, r.origin.y, layer,
           layer > 0 ? "  <- above normal windows (the banner)" : "");
    shown++;
  }
  if (!shown) printf("no windows on screen\n");
}

static void print_texts(AXUIElementRef el, int depth) {
  if (depth > 12) return;
  CFTypeRef role = NULL, title = NULL, value = NULL;
  AXUIElementCopyAttributeValue(el, kAXRoleAttribute, &role);
  AXUIElementCopyAttributeValue(el, kAXTitleAttribute, &title);
  AXUIElementCopyAttributeValue(el, kAXValueAttribute, &value);
  char r[64] = "", t[256] = "", v[256] = "";
  if (role && CFGetTypeID(role) == CFStringGetTypeID()) CFStringGetCString(role, r, sizeof r, kCFStringEncodingUTF8);
  if (title && CFGetTypeID(title) == CFStringGetTypeID()) CFStringGetCString(title, t, sizeof t, kCFStringEncodingUTF8);
  if (value && CFGetTypeID(value) == CFStringGetTypeID()) CFStringGetCString(value, v, sizeof v, kCFStringEncodingUTF8);
  if (t[0] || v[0]) printf("  %s: %s%s\n", r + 2, t, v);
  CFArrayRef kids = NULL;
  if (AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, (CFTypeRef *)&kids) == kAXErrorSuccess && kids)
    for (CFIndex k = 0; k < CFArrayGetCount(kids); k++) print_texts(CFArrayGetValueAtIndex(kids, k), depth + 1);
}

static int texts(pid_t pid) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  CFArrayRef windows = NULL;
  if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef *)&windows) != kAXErrorSuccess || !windows) return 1;
  for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) print_texts(CFArrayGetValueAtIndex(windows, i), 0);
  return 0;
}

static int press_button(pid_t pid, CFStringRef wanted) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  CFArrayRef windows = NULL;
  if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef *)&windows) != kAXErrorSuccess || !windows) return 1;
  // Walk each window a few levels down looking for a button with that name.
  for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
    AXUIElementRef stack[512];
    int depth[512], top = 0;
    stack[top] = CFArrayGetValueAtIndex(windows, i);
    depth[top++] = 0;
    while (top > 0) {
      AXUIElementRef el = stack[--top];
      int d = depth[top];
      CFTypeRef role = NULL, title = NULL;
      AXUIElementCopyAttributeValue(el, kAXRoleAttribute, &role);
      AXUIElementCopyAttributeValue(el, kAXTitleAttribute, &title);
      bool hit = role && title && CFEqual(role, kAXButtonRole) && CFGetTypeID(title) == CFStringGetTypeID() &&
                 CFStringCompare(title, wanted, 0) == kCFCompareEqualTo;
      if (role) CFRelease(role);
      if (title) CFRelease(title);
      if (hit) {
        AXError e = AXUIElementPerformAction(el, kAXPressAction);
        printf("pressed the button: %s\n", e == kAXErrorSuccess ? "ok" : "failed");
        return e == kAXErrorSuccess ? 0 : 1;
      }
      CFArrayRef kids = NULL;
      if (d < 8 && AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, (CFTypeRef *)&kids) == kAXErrorSuccess && kids) {
        for (CFIndex k = 0; k < CFArrayGetCount(kids) && top < 512; k++) {
          stack[top] = CFArrayGetValueAtIndex(kids, k);
          depth[top++] = d + 1;
        }
      }
    }
  }
  return 1;
}

int main(int argc, char **argv) {
  const char *cmd = argc > 1 ? argv[1] : "";
  pid_t pid = argc > 2 ? atoi(argv[2]) : 0;
  if (!strcmp(cmd, "move")) {
    post_move(2);
    usleep(30000);
    post_move(-2);
    printf("moved the mouse\n");
  } else if (!strcmp(cmd, "hotkey")) {
    CGEventFlags f = kCGEventFlagMaskControl | kCGEventFlagMaskAlternate;
    post_key(53, f, true);
    usleep(30000);
    post_key(53, f, false);
    printf("pressed Control + Option + Esc\n");
  } else if (!strcmp(cmd, "idle")) {
    CGEventType kinds[] = {kCGEventLeftMouseDown, kCGEventRightMouseDown, kCGEventOtherMouseDown, kCGEventMouseMoved,
                           kCGEventLeftMouseDragged, kCGEventKeyDown, kCGEventFlagsChanged, kCGEventScrollWheel};
    double least = 1e9;
    for (int i = 0; i < 8; i++) {
      double s = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kinds[i]);
      if (s < least) least = s;
    }
    printf("%.1f\n", least);
  } else if (!strcmp(cmd, "front") && pid) {
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    AXError e = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute, kCFBooleanTrue);
    printf("bring to front: %s\n", e == kAXErrorSuccess ? "ok" : "failed");
  } else if (!strcmp(cmd, "windows") && pid) {
    list_windows(pid);
  } else if (!strcmp(cmd, "texts") && pid) {
    return texts(pid);
  } else if ((!strcmp(cmd, "stop") || (!strcmp(cmd, "press") && argc > 3)) && pid) {
    CFStringRef wanted = argc > 3 ? CFStringCreateWithCString(NULL, argv[3], kCFStringEncodingUTF8) : CFSTR("Stop");
    // A web view builds its accessibility tree on first use, so the first look can come back empty.
    for (int attempt = 0; attempt < 4; attempt++) {
      if (press_button(pid, wanted) == 0) return 0;
      usleep(250000);
    }
    printf("no such button on screen\n");
    return 1;
  } else {
    fprintf(stderr, "usage: fake-user move | hotkey | idle | front <pid> | windows <pid> | texts <pid> | stop <pid> | press <pid> <button>\n");
    return 2;
  }
  return 0;
}
