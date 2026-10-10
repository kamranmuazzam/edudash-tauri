# Android Signing Guide for Tauri Apps

Since you plan to distribute the app using APKs (sideloading) and want an auto-updater, **the APK must be signed with the same key for updates to work seamlessly**. Android's security model dictates that an update must be signed with the identical Keystore as the originally installed app.

Because your local Java/Android SDK environment is currently missing, the keystore cannot be generated automatically right now. Follow these steps once you have Android Studio installed.

## 1. Generate the Keystore

Open your terminal in the `src-tauri` directory and run the following command (requires `keytool`, which is included with Android Studio / Java):

```bash
keytool -genkey -v -keystore dashboard-release.keystore -alias dashboard-alias -keyalg RSA -keysize 2048 -validity 10000
```

Keep track of the **Keystore Password** and **Alias Password** you enter.

## 2. Configure `build.gradle.kts`

Once you successfully run `npm run tauri android init`, Tauri will create the `src-tauri/gen/android` directory.

Navigate to `src-tauri/gen/android/app/build.gradle.kts` and add the signing configuration:

```kotlin
android {
    // Add the signingConfigs block
    signingConfigs {
        create("release") {
            val keystoreFile = project.rootProject.file("../../dashboard-release.keystore")
            if (keystoreFile.exists()) {
                storeFile = keystoreFile
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: "YOUR_KEYSTORE_PASSWORD"
                keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: "dashboard-alias"
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD") ?: "YOUR_KEY_PASSWORD"
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            
            // Attach the signature to the release build
            signingConfig = signingConfigs.getByName("release")
        }
    }
}
```

## 3. Build the Signed APK

Now when you want to build the final APK to upload to GitHub Releases, run:

```bash
npm run tauri android build -- --apk
```

Tauri will generate a perfectly signed APK ready for installation in `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`.
Upload this `.apk` to your GitHub Releases, and the custom Rust update logic we implemented will correctly trigger Android to download and install it!
