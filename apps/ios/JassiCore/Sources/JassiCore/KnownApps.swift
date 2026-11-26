import Foundation

/// An app we can look for on an iPhone: `id` is its bundle id in lower case, `scheme` is a link it answers.
public struct KnownApp: Equatable, Sendable {
    public let id: String
    public let name: String
    public let scheme: String

    public init(_ name: String, id: String, scheme: String) {
        self.id = id
        self.name = name
        self.scheme = scheme
    }
}

/// iPhone does not let an app list the other apps. It only answers "can anything open this kind of link?",
/// and only for link schemes named in Info.plist (`LSApplicationQueriesSchemes`, at most 50).
/// So `listApps()` checks this hand-picked list and says `partial: true` (contract §6).
/// Keep it in step with Info.plist: a test fails if the two differ.
public enum KnownApps {
    public static let limit = 50

    public static let all: [KnownApp] = [
        // Apple's own
        KnownApp("Maps", id: "com.apple.maps", scheme: "maps"),
        KnownApp("Calendar", id: "com.apple.mobilecal", scheme: "calshow"),
        KnownApp("Reminders", id: "com.apple.reminders", scheme: "x-apple-reminderkit"),
        KnownApp("Notes", id: "com.apple.mobilenotes", scheme: "mobilenotes"),
        KnownApp("Mail", id: "com.apple.mobilemail", scheme: "message"),
        KnownApp("Messages", id: "com.apple.mobilesms", scheme: "sms"),
        KnownApp("Phone", id: "com.apple.mobilephone", scheme: "tel"),
        KnownApp("FaceTime", id: "com.apple.facetime", scheme: "facetime"),
        KnownApp("Photos", id: "com.apple.mobileslideshow", scheme: "photos-redirect"),
        KnownApp("Music", id: "com.apple.music", scheme: "music"),
        KnownApp("Shortcuts", id: "com.apple.shortcuts", scheme: "shortcuts"),
        KnownApp("Files", id: "com.apple.documentsapp", scheme: "shareddocuments"),
        // Chat and social
        KnownApp("WhatsApp", id: "net.whatsapp.whatsapp", scheme: "whatsapp"),
        KnownApp("Telegram", id: "ph.telegra.telegraph", scheme: "tg"),
        KnownApp("Signal", id: "org.whispersystems.signal", scheme: "sgnl"),
        KnownApp("Messenger", id: "com.facebook.messenger", scheme: "fb-messenger"),
        KnownApp("Instagram", id: "com.burbn.instagram", scheme: "instagram"),
        KnownApp("Facebook", id: "com.facebook.facebook", scheme: "fb"),
        KnownApp("X", id: "com.atebits.tweetie2", scheme: "twitter"),
        KnownApp("LinkedIn", id: "com.linkedin.linkedin", scheme: "linkedin"),
        KnownApp("Snapchat", id: "com.toyopagroup.picaboo", scheme: "snapchat"),
        KnownApp("Discord", id: "com.hammerandchisel.discord", scheme: "discord"),
        KnownApp("Pinterest", id: "pinterest", scheme: "pinterest"),
        KnownApp("Truecaller", id: "com.truesoftware.truecallerother", scheme: "truecaller"),
        // Google
        KnownApp("Gmail", id: "com.google.gmail", scheme: "googlegmail"),
        KnownApp("Google Maps", id: "com.google.maps", scheme: "comgooglemaps"),
        KnownApp("Chrome", id: "com.google.chrome.ios", scheme: "googlechrome"),
        KnownApp("Google Drive", id: "com.google.drive", scheme: "googledrive"),
        KnownApp("Google Calendar", id: "com.google.calendar", scheme: "googlecalendar"),
        KnownApp("Google Photos", id: "com.google.photos", scheme: "googlephotos"),
        KnownApp("Google Docs", id: "com.google.docs", scheme: "googledocs"),
        KnownApp("Google Sheets", id: "com.google.sheets", scheme: "googlesheets"),
        KnownApp("YouTube", id: "com.google.ios.youtube", scheme: "youtube"),
        // Money and shopping
        KnownApp("Google Pay", id: "com.google.paisa", scheme: "tez"),
        KnownApp("PhonePe", id: "com.phonepe.phonepeapp", scheme: "phonepe"),
        KnownApp("Paytm", id: "net.one97.paytm", scheme: "paytmmp"),
        KnownApp("Flipkart", id: "com.appflipkart.flipkart", scheme: "flipkart"),
        // Food, rides, music, video
        KnownApp("Zomato", id: "com.zomato.zomato", scheme: "zomato"),
        KnownApp("Swiggy", id: "bundl.swiggy", scheme: "swiggy"),
        KnownApp("Uber", id: "com.ubercab.uberclient", scheme: "uber"),
        KnownApp("Spotify", id: "com.spotify.client", scheme: "spotify"),
        KnownApp("Netflix", id: "com.netflix.netflix", scheme: "nflx"),
        // Work
        KnownApp("Slack", id: "com.tinyspeck.chatlyio", scheme: "slack"),
        KnownApp("Zoom", id: "us.zoom.videomeetings", scheme: "zoomus"),
        KnownApp("Microsoft Teams", id: "com.microsoft.skype.teams", scheme: "msteams"),
        KnownApp("Outlook", id: "com.microsoft.office.outlook", scheme: "ms-outlook"),
        KnownApp("Word", id: "com.microsoft.office.word", scheme: "ms-word"),
        KnownApp("Excel", id: "com.microsoft.office.excel", scheme: "ms-excel"),
        KnownApp("PowerPoint", id: "com.microsoft.office.powerpoint", scheme: "ms-powerpoint"),
        KnownApp("Notion", id: "notion.id", scheme: "notion"),
    ]

    /// The link schemes Info.plist must declare.
    public static var schemes: [String] { all.map(\.scheme) }

    /// The apps from the list that are on this phone. `canOpen` asks the system about one scheme.
    public static func installed(canOpen: (String) -> Bool) -> [KnownApp] {
        Array(all.filter { canOpen($0.scheme) }.prefix(limit))
    }
}
