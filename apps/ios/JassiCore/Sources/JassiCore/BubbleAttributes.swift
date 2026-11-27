#if os(iOS)
import ActivityKit

/// The Live Activity behind the bubble. The app and the widget extension both use this one type.
public struct JassiBubbleAttributes: ActivityAttributes {
    public typealias ContentState = BubbleContent
    public init() {}
}
#endif
