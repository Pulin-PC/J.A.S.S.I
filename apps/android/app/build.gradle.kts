import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The web app this shell wraps. Point it somewhere else with -PjassiUrl=http://localhost:8787
val jassiUrl = (providers.gradleProperty("jassiUrl").orNull ?: "https://jassi.pulin-chaudhari.workers.dev").trimEnd('/')

android {
    namespace = "app.jassi.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.jassi.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "JASSI_URL", "\"$jassiUrl\"")
    }
    buildFeatures { buildConfig = true }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.browser:browser:1.9.0")
    implementation("androidx.biometric:biometric:1.1.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
