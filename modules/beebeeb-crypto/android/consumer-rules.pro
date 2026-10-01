# JNA (net.java.dev.jna:jna:5.19.1@aar) — use the AAR, never the plain jar.
# ≥ 5.17.0 is required for 16 KB page-size support.
-dontwarn java.awt.*
-keep class com.sun.jna.* { *; }
-keep class * extends com.sun.jna.* { *; }
-keepclassmembers class * extends com.sun.jna.* { public *; }

# UniFFI generated bindings — JNA reflects over structures and invokes
# callback implementations from native code by name.
-keep class uniffi.** { *; }
-keepclassmembers class * extends com.sun.jna.Structure { public *; }
-keep class * implements com.sun.jna.Callback { *; }
-keepclasseswithmembernames,includedescriptorclasses class * { native <methods>; }
