# Basic Pitch for Max

### Polyphonic Audio -> MIDI conversion in MaxMSP!

This project uses [nodeformax](https://docs.cycling74.com/apiref/nodeformax/) to run [Spotify's Basic Pitch](https://github.com/spotify/basic-pitch) algorithm within Max/MSP, thanks to the handy CLI version [basicpitch.cpp] (https://github.com/sevagh/basicpitch.cpp)

## Requirements

- macOS (currently only tested/built for Mac)
- [Max/MSP](https://cycling74.com/products/max)
- [ffmpeg](https://ffmpeg.org/) (required for audio preprocessing)

## Usage

1. Clone this repository.
2. Install dependencies as described in the project.
3. Use the provided Max patch to process audio files.
4. To preprocess non-WAV audio, use the included method to convert files to WAV.

See the helpfile for usage.

## Notes

- Only WAV files are accepted by default. Use the preprocess method for other formats.
- This project is based on [Spotify's Basic Pitch](https://github.com/spotify/basic-pitch) and references code from `basicpitch.cpp`.

## Citations

- [Spotify Basic Pitch](https://github.com/spotify/basic-pitch)
- [basicpitch.cpp] (https://github.com/sevagh/basicpitch.cpp)
