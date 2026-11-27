import ActivityKit
import SwiftUI
import WidgetKit
import JassiCore

/// The bubble on iPhone: iOS allows no window over other apps, so it is a Live Activity
/// in the Dynamic Island and on the Lock Screen.
@main
struct JassiWidgets: WidgetBundle {
    var body: some Widget { BubbleActivity() }
}

private let deep = Color(red: 1 / 255, green: 6 / 255, blue: 12 / 255)      // #01060c
private let cyan = Color(red: 70 / 255, green: 236 / 255, blue: 1)          // #46ecff
private let ink = Color(red: 227 / 255, green: 248 / 255, blue: 1)          // #e3f8ff

struct BubbleActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: JassiBubbleAttributes.self) { context in
            Card(view: Look(context))
                .padding(.horizontal, 18)
                .padding(.vertical, 16)
                .activityBackgroundTint(deep)
                .activitySystemActionForegroundColor(cyan)
                .widgetURL(DeepLink.talkURL)
        } dynamicIsland: { context in
            let view = Look(context)
            return DynamicIsland {
                // One full-width row under the camera, laid out like the Lock Screen.
                DynamicIslandExpandedRegion(.bottom) {
                    Card(view: view).padding(.horizontal, 6).padding(.bottom, 4)
                }
            } compactLeading: {
                Orb(state: view.state, size: 22)
            } compactTrailing: {
                Glyph(state: view.state, size: 14)
            } minimal: {
                Orb(state: view.state, size: 22)
            }
            .keylineTint(cyan)
            .widgetURL(DeepLink.talkURL)
        }
    }
}

/// What to draw. If the app has gone quiet (iOS paused it), show it asleep rather than still listening.
private struct Look {
    let state: BubbleState
    let caption: String
    let who: BubbleSpeaker

    init(_ context: ActivityViewContext<JassiBubbleAttributes>) {
        state = context.isStale ? .sleep : context.state.state
        caption = context.isStale ? "" : context.state.caption
        who = context.state.who
    }

    var word: String {
        switch state {
        case .sleep: return "Asleep"
        case .listening: return "Listening"
        case .thinking: return "Thinking"
        case .speaking: return "Speaking"
        }
    }
}

/// Orb, name, state and the caption: the Lock Screen and the opened Dynamic Island.
private struct Card: View {
    let view: Look

    var body: some View {
        HStack(spacing: 14) {
            Orb(state: view.state, size: 52)
            VStack(alignment: .leading, spacing: 5) {
                Title(view: view)
                Caption(view: view)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Glyph(state: view.state, size: 20)
        }
    }
}

private struct Title: View {
    let view: Look

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("J.A.S.S.I")
                .font(.system(size: 15, weight: .bold, design: .rounded))
                .tracking(0.8)
                .foregroundStyle(ink)
            Text(view.word)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(view.state == .sleep ? ink.opacity(0.5) : cyan)
        }
        .lineLimit(1)
    }
}

/// One line: live words (newest kept) or the reply. With no words, a hint.
private struct Caption: View {
    let view: Look

    var body: some View {
        Group {
            if view.caption.isEmpty {
                Text(view.state == .sleep ? "Tap to talk" : " ")
                    .foregroundStyle(ink.opacity(0.5))
            } else if view.who == .you {
                Text(view.caption)
                    .foregroundStyle(ink.opacity(0.78))
                    .truncationMode(.head)
            } else {
                Text(view.caption)
                    .foregroundStyle(ink)
                    .truncationMode(.tail)
            }
        }
        .font(.system(size: 14, weight: .medium))
        .lineLimit(1)
        .accessibilityLabel(view.caption.isEmpty ? "" : "\(view.who == .you ? "You" : "J.A.S.S.I"): \(view.caption)")
    }
}

/// A small symbol for the state, for places too narrow for words.
private struct Glyph: View {
    let state: BubbleState
    let size: CGFloat

    private var symbol: String {
        switch state {
        case .sleep: return "moon.zzz.fill"
        case .listening: return "waveform"
        case .thinking: return "ellipsis"
        case .speaking: return "speaker.wave.2.fill"
        }
    }

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(state == .sleep ? cyan.opacity(0.45) : cyan)
            .accessibilityHidden(true)
    }
}

/// The glass orb from the desktop bubble. A Live Activity cannot loop animations, so each state has its own still:
/// dim (asleep), glowing with a ring (listening), a comet arc (thinking), sound rings (speaking).
private struct Orb: View {
    let state: BubbleState
    let size: CGFloat

    private var glow: Double {
        switch state {
        case .sleep: return 0.15
        case .listening: return 1
        case .thinking: return 0.6
        case .speaking: return 0.85
        }
    }

    var body: some View {
        ZStack {
            Circle().fill(RadialGradient(colors: [cyan.opacity(0.55 * glow), cyan.opacity(0)],
                                         center: .center, startRadius: size * 0.28, endRadius: size * 0.5))
            glass.frame(width: size * 0.76, height: size * 0.76)
            marks
        }
        .frame(width: size, height: size)
        .opacity(state == .sleep ? 0.7 : 1)
        .accessibilityLabel("J.A.S.S.I")
    }

    private var glass: some View {
        let d = size * 0.76
        return ZStack {
            Circle().fill(RadialGradient(colors: [Color(red: 0.043, green: 0.196, blue: 0.278),
                                                  Color(red: 0.016, green: 0.094, blue: 0.165), deep],
                                         center: UnitPoint(x: 0.5, y: 0.55), startRadius: 0, endRadius: d * 0.52))
            Circle().fill(RadialGradient(colors: [Color(red: 0.67, green: 0.96, blue: 1).opacity(0.42), .clear],
                                         center: UnitPoint(x: 0.32, y: 0.26), startRadius: 0, endRadius: d * 0.34))
            // The core of light.
            Circle().fill(RadialGradient(stops: [.init(color: Color(red: 0.95, green: 1, blue: 1), location: 0.1),
                                                 .init(color: cyan, location: 0.42),
                                                 .init(color: cyan.opacity(0.25), location: 0.7),
                                                 .init(color: cyan.opacity(0), location: 1)],
                                         center: .center, startRadius: 0, endRadius: d * 0.3))
                .frame(width: d * 0.6, height: d * 0.6)
                .scaleEffect(state == .sleep ? 0.72 : state == .speaking ? 1.15 : 1)
                .opacity(state == .sleep ? 0.55 : 1)
            // The glint.
            Ellipse().fill(.white.opacity(0.55))
                .frame(width: d * 0.2, height: d * 0.11)
                .rotationEffect(.degrees(-28))
                .offset(x: -d * 0.17, y: -d * 0.26)
            Circle().strokeBorder(cyan.opacity(0.35 + 0.5 * glow), lineWidth: max(1, size / 44))
        }
    }

    @ViewBuilder private var marks: some View {
        let line = max(1, size / 32)
        switch state {
        case .sleep:
            EmptyView()
        case .listening:
            Circle().strokeBorder(cyan.opacity(0.75), lineWidth: line).padding(size * 0.04)
        case .thinking:
            Circle()
                .trim(from: 0, to: 0.36)
                .stroke(AngularGradient(colors: [cyan.opacity(0), cyan, .white],
                                        center: .center, startAngle: .degrees(0), endAngle: .degrees(130)),
                        style: StrokeStyle(lineWidth: line * 1.4, lineCap: .round))
                .rotationEffect(.degrees(-110))
                .padding(size * 0.05)
        case .speaking:
            // Arcs of sound on both sides.
            ForEach([0.0, 180.0], id: \.self) { side in
                Circle().trim(from: 0, to: 0.22)
                    .stroke(cyan.opacity(0.9), style: StrokeStyle(lineWidth: line, lineCap: .round))
                    .rotationEffect(.degrees(side - 40))
                    .padding(size * 0.03)
            }
        }
    }
}
