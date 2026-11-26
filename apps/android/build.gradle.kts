plugins {
    id("com.android.application") version "8.13.0" apply false
    id("org.jetbrains.kotlin.android") version "2.2.0" apply false
}

// The repo sits in a synced folder, so build output goes to a cache folder outside it.
// Override with -Pjassi.buildRoot=/some/folder.
val home: String = System.getProperty("user.home")
val defaultRoot = if (System.getProperty("os.name").startsWith("Mac")) "$home/Library/Caches/jassi/android" else "$home/.cache/jassi/android"
val buildRoot = providers.gradleProperty("jassi.buildRoot").orNull ?: defaultRoot
allprojects {
    layout.buildDirectory.set(file("$buildRoot/${project.name}"))
}
