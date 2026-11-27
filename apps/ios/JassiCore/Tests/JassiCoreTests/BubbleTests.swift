import Foundation
import Testing
@testable import JassiCore

/// Reads the arguments the way they arrive from the page: as JSON turned into Foundation values.
private func parse(_ json: String) throws -> Result<BridgeCall, BridgeFailure> {
    let args = try JSONSerialization.jsonObject(with: Data(json.utf8), options: .fragmentsAllowed)
    return BridgeRouter.parse(["method": "bubble", "args": args] as [String: Any])
}

private func bubble(_ update: BubbleUpdate) -> Result<BridgeCall, BridgeFailure> { .success(.bubble(update)) }

@Suite("Reading bubble calls")
struct BubbleParsingTests {
    @Test func theCallsTheWebAppMakes() throws {
        #expect(try parse(#"{"visible":true,"state":"sleep"}"#) == bubble(.init(visible: true, state: .sleep)))
        #expect(try parse(#"{"visible":false}"#) == bubble(.init(visible: false)))
        #expect(try parse(#"{"state":"thinking"}"#) == bubble(.init(state: .thinking)))
        #expect(try parse(#"{"text":"pay Asha","who":"you"}"#) == bubble(.init(text: "pay Asha", who: .you)))
        #expect(try parse(#"{"text":"Done.","who":"jassi"}"#) == bubble(.init(text: "Done.", who: .jassi)))
    }

    @Test func everyStateIsKnown() throws {
        for state in BubbleState.allCases {
            #expect(try parse(#"{"state":"\#(state.rawValue)"}"#) == bubble(.init(state: state)))
        }
    }

    @Test func nullMeansLeftOutAndEmptyTextClears() throws {
        #expect(try parse(#"{"visible":true,"state":null,"text":null,"who":null}"#) == bubble(.init(visible: true)))
        #expect(try parse(#"{"text":""}"#) == bubble(.init(text: "")))
    }

    @Test func wrongValuesAreRefused() throws {
        for bad in [#"{"visible":"true"}"#, #"{"visible":1}"#, #"{"state":"dancing"}"#, #"{"state":3}"#,
                    #"{"text":42}"#, #"{"text":"hi","who":"someone"}"#, #"{}"#, #"{"colour":"red"}"#,
                    #""listening""#, "null", "[true]"] {
            #expect(try parse(bad) == .failure(.badArgs), "\(bad)")
        }
    }
}

@Suite("The caption")
struct BubbleCaptionTests {
    @Test func isOneLine() {
        #expect(BubbleContent.line("  Paid.\n\nAnything\telse? ", who: .jassi) == "Paid. Anything else?")
    }

    @Test func liveWordsKeepTheEndAndRepliesKeepTheStart() {
        #expect(BubbleContent.line("one two three four", who: .you, limit: 11) == "…three four")
        #expect(BubbleContent.line("one two three four", who: .jassi, limit: 9) == "one two…")
        let long = String(repeating: "word ", count: 200)
        #expect(BubbleContent.line(long, who: .you).count <= BubbleContent.captionLimit)
        #expect(BubbleContent.line(long, who: .jassi).count <= BubbleContent.captionLimit)
    }
}

@Suite("When the bubble changes")
struct BubblePlannerTests {
    private let start = Date(timeIntervalSinceReferenceDate: 1000)
    private func at(_ seconds: TimeInterval) -> Date { start.addingTimeInterval(seconds) }

    private func shownPlanner(_ state: BubbleState = .listening) -> BubblePlanner {
        var planner = BubblePlanner()
        _ = planner.apply(.init(visible: true, state: state), now: at(0))
        return planner
    }

    @Test func nothingShowsUntilItIsAskedFor() {
        var planner = BubblePlanner()
        #expect(planner.apply(.init(state: .listening), now: at(0)) == .none)
        #expect(planner.apply(.init(text: "hello", who: .you), now: at(1)) == .none)
        #expect(planner.apply(.init(visible: true), now: at(2)) == .show(.init(state: .listening)))
    }

    @Test func liveWordsAreHeldToOneUpdateASecond() {
        var planner = shownPlanner()
        var sent = 0
        // Ten new transcripts a second for five and a half seconds.
        for tick in 1...55 {
            if case .show = planner.apply(.init(text: "word \(tick)", who: .you), now: at(Double(tick) / 10)) { sent += 1 }
        }
        #expect(sent == 5)
        #expect(planner.next(now: at(6.1)) == .show(.init(state: .listening, caption: "word 55", who: .you)))
    }

    @Test func aWaitingCaptionGoesOutWhenItsTimeComes() {
        var planner = shownPlanner()
        guard case .wait(let seconds) = planner.apply(.init(text: "pay", who: .you), now: at(0.4)) else {
            Issue.record("expected a wait"); return
        }
        #expect(abs(seconds - 0.6) < 0.001)
        #expect(planner.next(now: at(1.0)) == .show(.init(state: .listening, caption: "pay", who: .you)))
    }

    @Test func aChangeOfStateDoesNotWaitAsLong() {
        var planner = shownPlanner()
        #expect(planner.apply(.init(state: .thinking), now: at(0.5)) == .show(.init(state: .thinking)))
    }

    @Test func theSameThingTwiceIsSentOnce() {
        var planner = shownPlanner()
        #expect(planner.apply(.init(state: .listening), now: at(2)) == .none)
    }

    @Test func askingForItAgainAlwaysSends() {
        var planner = shownPlanner()
        #expect(planner.apply(.init(visible: true, state: .listening), now: at(2)) == .show(.init(state: .listening)))
    }

    @Test func theCaptionFadesAfterTheLastWords() {
        var planner = shownPlanner()
        _ = planner.apply(.init(text: "pay Asha", who: .you), now: at(2))
        guard case .wait(let seconds) = planner.next(now: at(2)) else { Issue.record("expected a wait"); return }
        #expect(abs(seconds - BubblePlanner.captionLife) < 0.001)
        #expect(planner.next(now: at(8.1)) == .show(.init(state: .listening, caption: "", who: .you)))
    }

    @Test func theCaptionStaysWhileJassiTalks() {
        var planner = shownPlanner(.speaking)
        _ = planner.apply(.init(text: "A long answer", who: .jassi), now: at(2))
        #expect(planner.next(now: at(30)) == .none)
        // Then lingers for its usual time once the talking stops.
        #expect(planner.apply(.init(state: .listening), now: at(31)) == .show(.init(state: .listening, caption: "A long answer")))
        #expect(planner.next(now: at(37.1)) == .show(.init(state: .listening)))
    }

    @Test func leavingTheScreenSendsWhatIsWaiting() {
        var planner = shownPlanner()
        _ = planner.apply(.init(text: "pay", who: .you), now: at(0.1))
        #expect(planner.flush(now: at(0.2)) == .show(.init(state: .listening, caption: "pay", who: .you)))
        #expect(planner.flush(now: at(0.3)) == .none)
    }

    @Test func hidingEndsItAndForgetsTheWords() {
        var planner = shownPlanner()
        _ = planner.apply(.init(text: "secret", who: .you), now: at(2))
        #expect(planner.apply(.init(visible: false), now: at(3)) == .end)
        #expect(!planner.shown)
        #expect(planner.apply(.init(state: .speaking), now: at(4)) == .none)
        #expect(planner.apply(.init(visible: true, state: .listening), now: at(5)) == .show(.init(state: .listening)))
    }
}

@Suite("The bubble's link")
struct BubbleLinkTests {
    @Test func talkOpensFromTheLiveActivity() {
        #expect(DeepLink.parse(DeepLink.talkURL) == .talk)
        #expect(DeepLink.parse(URL(string: "JASSI://Talk")!) == .talk)
        #expect(DeepLink.parse(URL(string: "https://talk")!) == nil)
        #expect(DeepLink.parse(URL(string: "jassi://other")!) == nil)
    }
}
