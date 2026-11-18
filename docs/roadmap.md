# Roadmap

What's planned next for SlingSync, roughly in order. Ideas and votes are welcome in [Issues](https://github.com/dyanez-arch/slingsync/issues/new/choose). What has already been built and tested is in the [changelog](../CHANGELOG.md) and the [testing log](testing.md).

## Next

### Premiere Pro plug-in: sync inside the project (built: 0.16.0 – 0.17.0)
*Sync Selected Bin* (builds the sequence from your own clips, no duplicates) and *Sync Timeline* (the open sequence, or only the selected clips) are built and tested against a simulated Premiere; next is testing inside Premiere. Besides a **folder on disk**, the plug-in syncs clips that are **already in the Premiere project**: select a bin (one sub-bin per camera or recorder, like the folders today) or a set of clips, click Sync, and get the synced sequence. Same engine, same results; the plug-in reads each clip's media path from Premiere instead of scanning a folder. Useful when the footage is already imported and organised, or spread over several drives.

### Screenshots
Pictures of the app and the plug-in in the README and on the release page, so people can see what they're getting before downloading.

### Plug-in: confirm in Premiere
Bin sorting by device (0.15.0), the audio-file export and *Import a synced folder* are tested against a simulated Premiere but not yet inside Premiere.

## Later

### Intel Mac build
Releases are built for Apple Silicon Macs only; Intel Macs can run SlingSync from source. Plan: add an Intel build to the GitHub release workflow (depends on GitHub still offering Intel Mac build machines) and test it on an Intel Mac. The Premiere plug-in is JavaScript and WebAssembly, so it should already run on Intel Macs with Premiere 2027.

### Older versions of Premiere and macOS
- **Desktop app:** works with any Premiere version that imports Final Cut Pro 7 XML (all recent ones), and any editor that reads it. It needs macOS 12 or later.
- **Plug-in:** needs Premiere Pro 2027 (27.0) today. Most of the editing API it uses exists since Premiere 25.6 (2025), so Premiere 2025 and 2026 may be possible; it needs checking feature by feature (some calls, like project-item types, are 27.0+) and testing on those versions.
- **Windows:** the plug-in's engine is platform-independent, so Premiere on Windows is possible in principle; file paths would need adapting and it needs testing. The desktop app is Mac-only.

### No "unverified" warnings, once there are enough supporters
Today macOS warns that the app is from an unverified developer (you allow it once in Privacy & Security), and the plug-in installs as a third-party plugin. Removing the warnings costs money and paperwork:
- **App:** an Apple Developer ID and notarisation, **$99 per year**.
- **Plug-in:** listing on Adobe's marketplace (Creative Cloud) is free but needs Adobe's review and a developer account.

SlingSync stays free. When donations on **[Ko-fi](https://ko-fi.com/pisdronio)** cover the Apple fee, the app gets signed and notarised and the plug-in goes to Adobe's marketplace.

### Speed: desktop app vs plug-in
A fair, documented comparison on the same shoot: from an internal SSD and from a USB drive, nothing cached, Premiere idle. What's known so far: reading files is the same speed in both (on a USB drive the drive is the limit). The app analyses up to 6 files at once, while the plug-in does one at a time (Premiere gives plug-ins one thread), so the app should be faster on fast drives. This is not measured yet. Both stay free.

### More real-world testing
Mixed frame rates in one project (23.976 / 25 / 29.97 / 50), variable-frame-rate phone footage, NAS and read-only drives (the analysis cache is written inside the shoot folder), and very long recordings on 8 GB Macs. See *Not tested yet* in the [testing log](testing.md).

## Ideas, not yet planned
- Sync Timeline: the device list and Options step (it uses the recommended settings today), and moving clips onto separate tracks automatically when they share one.
- Remember the last settings in the plug-in.
- Show the report inside the plug-in, with links to the clips to check.
- Faster analysis of 4K camera files on slow drives (read the recorder's audio first, cameras in the background).
