const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Max = require('max-api');

class BasicPitchServer {
    constructor() {
        this.daemonProcess = null;
        this.daemonReady = false;
        this.pendingRequests = new Map();
        this.processedMidiFiles = new Set(); // Track processed MIDI files to prevent duplicates
        this.requestCounter = 0;
        
        // Bind methods to preserve 'this' context
        this.processAudioFile = this.processAudioFile.bind(this);
        this.handleDaemonOutput = this.handleDaemonOutput.bind(this);
        this.preprocessAudioFile = this.preprocessAudioFile.bind(this);
        
        // Start the daemon
        this.startDaemon();
        
        // Set up Max API handlers
        this.setupMaxHandlers();
        
        // Set up periodic cleanup of stale requests
        this.setupCleanupTimer();
        
        // Handle graceful shutdown
        process.on('SIGINT', this.shutdown.bind(this));
        process.on('SIGTERM', this.shutdown.bind(this));
        
        // Handle uncaught exceptions to prevent crashes
        process.on('uncaughtException', (error) => {
            Max.post(`❌ Uncaught exception: ${error.message}`);
            Max.post(`Stack trace: ${error.stack}`);
            Max.outlet('error', `Uncaught exception: ${error.message}`);
        });
        
        // Handle unhandled promise rejections
        process.on('unhandledRejection', (reason, promise) => {
            Max.post(`❌ Unhandled promise rejection: ${reason}`);
            Max.outlet('error', `Unhandled promise rejection: ${reason}`);
        });
    }

    setupCleanupTimer() {
        // Clean up stale requests every 20 seconds
        setInterval(() => {
            const now = Date.now();
            const staleRequests = [];
            
            for (const [filePath, requestInfo] of this.pendingRequests.entries()) {
                const age = now - requestInfo.startTime;
                if (age > 20000) { // 20 seconds for periodic cleanup
                    staleRequests.push(filePath);
                }
            }
            
            for (const filePath of staleRequests) {
                const requestInfo = this.pendingRequests.get(filePath);
                const fileName = path.basename(filePath);
                
                Max.post(`🧹 Auto-cleanup stale request: ${fileName} (${Math.round((now - requestInfo.startTime)/1000)}s old)`);
                
                // Cleanup any temp file if it exists
                if (requestInfo.cleanupFile && fs.existsSync(requestInfo.cleanupFile)) {
                    fs.unlinkSync(requestInfo.cleanupFile);
                    Max.post(`🗑️ Cleaned up stale temp file: ${path.basename(requestInfo.cleanupFile)}`);
                }
                
                this.pendingRequests.delete(filePath);
            }
        }, 20000); // Run every 20 seconds
    }

    setupMaxHandlers() {
        // Handler for processing audio files
        Max.addHandler('path', (audioPath) => {
            if (!audioPath) {
                Max.post('Error: No audio path provided');
                Max.outlet('error', 'No audio path provided');
                return;
            }
            
            Max.post(`Received path: ${audioPath}`);
            
            // Wrap async call in try-catch to prevent process crashes
            this.processAudioFile(audioPath).catch(error => {
                Max.post(`❌ Error in processAudioFile: ${error.message}`);
                Max.outlet('error', `Processing error: ${error.message}`, audioPath);
            });
        });
        
        // Handler for processing with preprocessing
        Max.addHandler('preprocess', (audioPath) => {
            if (!audioPath) {
                Max.post('Error: No audio path provided');
                Max.outlet('error', 'No audio path provided');
                return;
            }
                    
            // Wrap async call in try-catch to prevent process crashes
            this.processAudioFile(audioPath, null, true).catch(error => {
                Max.post(`❌ Error in processAudioFile (preprocess): ${error.message}`);
                Max.outlet('error', `Preprocessing error: ${error.message}`, audioPath);
            });
        });
        
        // Handler for checking daemon status
        Max.addHandler('status', () => {
            const status = this.daemonReady ? 'ready' : 'not ready';
            Max.post(`Daemon status: ${status}`);
            Max.outlet('status', status);
        });
        
        // Handler for getting pending requests count
        Max.addHandler('pending', () => {
            const count = this.pendingRequests.size;
            Max.post(`Pending requests: ${count}`);
            Max.outlet('pending', count);
        });
        
        // Bang handler for general info
        Max.addHandler('bang', () => {
            const status = this.daemonReady ? 'ready' : 'initializing';
            const pending = this.pendingRequests.size;
            Max.post(`BasicPitch Server - Status: ${status}, Pending: ${pending}`);
            Max.outlet('info', status, pending);
        });

        // Handler for setting parameters and restarting daemon
        Max.addHandler('flags', (...args) => {
            try {
                // Remove the first argument which is the message name
                const paramList = args.slice(0);
                
                Max.post(`📝 Received flags: ${JSON.stringify(paramList)}`);
                
                // Parse and validate the parameters
                const flags = this.parseMaxListToFlags(paramList);
                
                if (flags.length === 0) {
                    Max.post('📝 No parameters provided, using default settings');
                    return;
                }
                
                Max.post(`✅ Parsed flags: ${flags.join(' ')}`);
                
                // Restart daemon with new parameters
                this.restartDaemonWithFlags(flags);
                
            } catch (error) {
                Max.post(`❌ Flags error: ${error.message}`);
                Max.outlet('flags_error', error.message);
            }
        });
    }
    
    startDaemon(flags = []) {
        // Prevent starting multiple daemons
        if (this.daemonProcess) {
            Max.post(`⚠️ Daemon already running. Use stopDaemon() first if restart needed.`);
            return;
        }
        
        const cliPath = path.join(__dirname, 'basic-pitch-cli', 'basicpitch_daemon');
        const tempDir = path.join(__dirname, 'temp-midi');
        
        // Create temp directory if it doesn't exist
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // Build command arguments
        const args = ['--daemon', tempDir, ...flags];
        
        console.log('Starting BasicPitch daemon...');
        console.log(`Command: ${cliPath} ${args.join(' ')}`);
        this.daemonProcess = spawn(cliPath, args);
        
        this.daemonProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            // Max.post(`Daemon: ${output}`);
            
            if (output.includes('Ready for commands')) {
                this.daemonReady = true;
                Max.post('✅ BasicPitch daemon is ready for processing');
                Max.outlet('daemon_ready');
            } else {
                this.handleDaemonOutput(output);
            }
        });
        
        this.daemonProcess.stderr.on('data', (data) => {
            const error = data.toString().trim();
            
            // Filter out noisy ONNX schema registration warnings
            if (error.includes('Schema error') ||
                error.includes('but it is already registered from file')) {
                // These are harmless ONNX Runtime warnings, suppress them
                return;
            }
            
            // Only log actual errors that matter
            if (error && error.length > 0) {
                Max.post(`Daemon error: ${error}`);
            }
        });
        
        this.daemonProcess.on('close', (code) => {
            Max.post(`Daemon exited with code ${code}`);
            Max.outlet('daemon_closed', code);
            this.daemonReady = false;
            this.daemonProcess = null;
            
            // Clear any pending requests since daemon is dead
            this.pendingRequests.clear();
            
            // Don't automatically restart - let explicit calls handle restart
            Max.post(`🛑 Daemon stopped. Use 'flags' command or send new file to restart.`);
        });
        
        this.daemonProcess.on('error', (error) => {
            Max.post(`Failed to start daemon: ${error.message}`);
            Max.outlet('daemon_start_error', error.message);
            this.daemonReady = false;
        });
    }

    // Stop the current daemon if running
    stopDaemon() {
        return new Promise((resolve) => {
            if (this.daemonProcess) {
                Max.post('🛑 Stopping current daemon...');
                
                // Set up cleanup when process closes
                this.daemonProcess.once('close', () => {
                    this.daemonReady = false;
                    this.daemonProcess = null;
                    Max.post('✅ Daemon stopped');
                    resolve();
                });
                
                // Send quit command and kill if necessary
                this.daemonProcess.stdin.write('quit\n');
                
                // Force kill after timeout
                setTimeout(() => {
                    if (this.daemonProcess) {
                        this.daemonProcess.kill('SIGKILL');
                    }
                }, 3000);
            } else {
                resolve();
            }
        });
    }

    // Restart daemon with new flags
    async restartDaemonWithFlags(flags) {
        Max.post('🔄 Restarting daemon with new parameters...');
        
        try {
            // Stop current daemon
            await this.stopDaemon();
            
            // Start daemon with new flags
            this.startDaemon(flags);
            
            Max.post('✅ Daemon restart initiated');
            Max.outlet('daemon_restarting');
            Max.outlet('flags_applied', flags.join(' '));
            
        } catch (error) {
            Max.post(`❌ Error restarting daemon: ${error.message}`);
            Max.outlet('daemon_restart_error', error.message);
        }
    }

    // Validate parameter values according to CLI specification
    validateParameter(key, value) {
        const validations = {
            'onset-threshold': {
                min: 0.0,
                max: 1.0,
                type: 'number',
                description: 'Onset threshold (higher = fewer onsets detected)'
            },
            'frame-threshold': {
                min: 0.0,
                max: 1.0,
                type: 'number',
                description: 'Frame threshold (higher = fewer notes detected)'
            },
            'min-frequency': {
                min: 20.0,
                max: 8000.0,
                type: 'number',
                description: 'Minimum frequency in Hz'
            },
            'max-frequency': {
                min: 20.0,
                max: 8000.0,
                type: 'number',
                description: 'Maximum frequency in Hz'
            },
            'min-note-length': {
                min: 0.01,
                max: 10.0,
                type: 'number',
                description: 'Minimum note length in seconds'
            },
            'tempo-bpm': {
                min: 60.0,
                max: 200.0,
                type: 'number',
                description: 'Tempo in BPM for beat tracking'
            },
            'use-melodia-trick': {
                type: 'boolean',
                description: 'Use melodia trick for better pitch tracking'
            },
            'include-pitch-bends': {
                type: 'boolean',
                description: 'Include pitch bends in MIDI output'
            }
        };

        const validation = validations[key];
        if (!validation) {
            throw new Error(`Unknown parameter: ${key}`);
        }

        if (validation.type === 'number') {
            const numValue = parseFloat(value);
            if (isNaN(numValue)) {
                throw new Error(`${key}: Value must be a number`);
            }
            if (numValue < validation.min || numValue > validation.max) {
                throw new Error(`${key}: Value ${numValue} out of range [${validation.min}, ${validation.max}]`);
            }
            return numValue;
        } else if (validation.type === 'boolean') {
            if (value === true || value === 'true' || value === '1' || value === 1) {
                return true;
            } else if (value === false || value === 'false' || value === '0' || value === 0) {
                return false;
            } else {
                throw new Error(`${key}: Value must be true/false`);
            }
        }

        return value;
    }

    // Parse Max list into CLI flags
    parseMaxListToFlags(maxList) {
        const flags = [];
        
        try {
            // Max sends arguments as separate items in the list
            // Expected format: key1 value1 key2 value2 ...
            for (let i = 0; i < maxList.length; i += 2) {
                if (i + 1 >= maxList.length) {
                    throw new Error(`Missing value for parameter: ${maxList[i]}`);
                }
                
                const key = maxList[i].toString().replace(/^-+/, ''); // Remove leading dashes if present
                const value = maxList[i + 1];
                
                // Validate the parameter
                const validatedValue = this.validateParameter(key, value);
                
                // Handle special boolean flags that use --no- prefix
                if (key === 'include-pitch-bends') {
                    // If false (0), add --no-pitch-bends flag
                    if (!validatedValue) {
                        flags.push('--no-pitch-bends');
                    }
                    // If true (1), don't add any flag (pitch bends enabled by default)
                } else if (key === 'use-melodia-trick') {
                    // If false (0), add --no-melodia-trick flag
                    if (!validatedValue) {
                        flags.push('--no-melodia-trick');
                    }
                    // If true (1), don't add any flag (melodia trick enabled by default)
                } else {
                    // Handle regular parameters
                    if (typeof validatedValue === 'boolean') {
                        if (validatedValue) {
                            flags.push(`--${key}`);
                        }
                        // For boolean false, we don't add the flag
                    } else {
                        flags.push(`--${key}`);
                        flags.push(validatedValue.toString());
                    }
                }
            }
            
            return flags;
            
        } catch (error) {
            throw new Error(`Parameter validation failed: ${error.message}`);
        }
    }
    
    // Find ffmpeg binary in common locations
    findFFmpegPath() {
        const commonPaths = [
            '/opt/homebrew/bin/ffmpeg',  // Apple Silicon Homebrew
            '/usr/local/bin/ffmpeg',     // Intel Homebrew
            '/usr/bin/ffmpeg',           // System install
            '/Applications/ffmpeg',      // Manual install
        ];
        
        // Check common paths first
        for (const ffmpegPath of commonPaths) {
            try {
                if (fs.existsSync(ffmpegPath)) {
                    Max.post(`Found ffmpeg at: ${ffmpegPath}`);
                    return ffmpegPath;
                }
            } catch (error) {
                // Continue to next path
            }
        }
        
        // Try to use 'which' command to find ffmpeg in PATH
        try {
            const { execSync } = require('child_process');
            const result = execSync('which ffmpeg', { encoding: 'utf8' }).trim();
            if (result) {
                Max.post(`Found ffmpeg via which: ${result}`);
                return result;
            }
        } catch (error) {
            // which command failed
        }
        
        Max.post('❌ ffmpeg not found in common locations');
        return null;
    }

    // Preprocess audio file with ffmpeg to ensure compatibility
    async preprocessAudioFile(inputPath) {
        return new Promise((resolve, reject) => {
            const inputDir = path.dirname(inputPath);
            const inputBaseName = path.basename(inputPath, path.extname(inputPath));
            const preprocessedPath = path.join(inputDir, `${inputBaseName}.proc.wav`);
            
            const ffmpegPath = this.findFFmpegPath();
            
            if (!ffmpegPath) {
                reject(new Error('ffmpeg not found. Please install with: brew install ffmpeg'));
                return;
            }
            
            // ffmpeg command to convert to a clean WAV format
            const ffmpegArgs = [
                '-i', inputPath,           // Input file
                '-ar', '22050',            // Sample rate (BasicPitch expects 22050)
                '-ac', '1',                // Convert to mono
                '-sample_fmt', 's16',      // 16-bit PCM
                '-y',                      // Overwrite output file
                preprocessedPath           // Output file
            ];
            
            Max.post(`🔧 Preprocessing audio: ${path.basename(inputPath)} -> ${path.basename(preprocessedPath)}`);
            Max.post(`Using ffmpeg: ${ffmpegPath}`);
            
            const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);
            
            let errorOutput = '';
            
            ffmpegProcess.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });
            
            ffmpegProcess.on('close', (code) => {
                if (code === 0) {
                    Max.post(`✅ Preprocessing complete: ${path.basename(preprocessedPath)}`);
                    resolve(preprocessedPath);
                } else {
                    Max.post(`❌ Preprocessing failed: ${errorOutput}`);
                    reject(new Error(`ffmpeg failed with code ${code}: ${errorOutput}`));
                }
            });
            
            ffmpegProcess.on('error', (error) => {
                Max.post(`❌ ffmpeg error: ${error.message}`);
                reject(error);
            });
        });
    }
    
    async processAudioFile(filePath, requestId = null, usePreprocessing = false) {
        Max.post(`📁 Processing audio file: ${filePath}`);
        
        // Check if file exists (use original path without escaping)
        if (!fs.existsSync(filePath)) {
            const error = `File not found: ${filePath}`;
            Max.post(`❌ Error: ${error}`);
            Max.outlet('error', error, filePath);
            return;
        }
        
        // Check if daemon is ready - if not, start it but don't restart if it's already running
        if (!this.daemonReady || !this.daemonProcess) {
            if (!this.daemonProcess) {
                Max.post(`🔄 Starting daemon for file processing...`);
                this.startDaemon();
                // Wait a moment for daemon to initialize
                try {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    Max.post(`❌ Error waiting for daemon: ${error.message}`);
                    Max.outlet('error', `Daemon initialization error: ${error.message}`, filePath);
                    return;
                }
            }
            
            if (!this.daemonReady) {
                const error = 'Daemon not ready after initialization. Please try again.';
                Max.post(`❌ Error: ${error}`);
                Max.outlet('error', error, filePath);
                return;
            }
        }
        
        // Check if this file is already being processed
        if (this.pendingRequests.has(filePath)) {
            const requestInfo = this.pendingRequests.get(filePath);
            const age = Date.now() - requestInfo.startTime;

            // If request is older than 20 seconds, assume it's stuck and remove it
            if (age > 20000) {
                const fileName = path.basename(filePath);
                Max.post(`Clearing stale request for: ${fileName} (${Math.round(age/1000)}s old)`);
                
                // Cleanup any temp file if it exists
                if (requestInfo.cleanupFile && fs.existsSync(requestInfo.cleanupFile)) {
                    fs.unlinkSync(requestInfo.cleanupFile);
                    Max.post(`🗑️ Cleaned up stale temp file: ${path.basename(requestInfo.cleanupFile)}`);
                }
                
                this.pendingRequests.delete(filePath);
            } else {
                const fileName = path.basename(filePath);
                Max.post(`File already being processed: ${fileName} (${age / 1000}s ago)`);
                return;
            }
        }
        
        let actualFilePath = filePath;
        let cleanupFile = null;
        
        // Preprocess if requested or if file extension suggests it might be problematic
        const ext = path.extname(filePath).toLowerCase();
        const problematicFormats = ['.mp3', '.m4a', '.aac', '.flac', '.ogg'];
        
        if (usePreprocessing || problematicFormats.includes(ext)) {
            try {
                actualFilePath = await this.preprocessAudioFile(filePath);
                cleanupFile = actualFilePath; // Mark for cleanup later
            } catch (error) {
                Max.post(`❌ Preprocessing failed: ${error.message}`);
                Max.outlet('error', `Preprocessing failed: ${error.message}`, filePath);
                return;
            }
        }
        
        // Get the directory of the input file for output (use original path for output location)
        const inputDir = path.dirname(filePath);
        const fileName = path.basename(filePath);
        const audioBaseName = path.basename(filePath, path.extname(filePath));
        const expectedMidiPath = path.join(inputDir, `${audioBaseName}.mid`);
        
        // Store the request with expected output path (use actualFilePath as key for daemon matching)
        const internalRequestId = ++this.requestCounter;
        this.pendingRequests.set(actualFilePath, { 
            requestId: requestId || internalRequestId, 
            startTime: Date.now(),
            fileName: fileName,
            expectedMidiPath: expectedMidiPath,
            originalFilePath: filePath,
            originalBaseName: audioBaseName,  // Store original basename for MIDI output
            cleanupFile: cleanupFile
        });
        
        // Send the process command to the daemon with custom output directory
        // Use proper quotes - the daemon now handles them correctly with improved parsing
        const command = `process "${actualFilePath}" "${inputDir}"\n`;
        
        // Debug: Log the exact command being sent
        Max.post(`🔍 Debug: Sending command to daemon: ${command.trim()}`);
        
        this.daemonProcess.stdin.write(command);
        
        Max.post(`🔄 Processing started for: ${fileName} -> ${expectedMidiPath}`);
        Max.outlet('processing_started', fileName, filePath);
    }
    
    handleDaemonOutput(output) {
        const lines = output.split('\n');
        
        for (const line of lines) {
            if (line.startsWith('SUCCESS:')) {
                // Parse success message: SUCCESS: "./temp-midi/vocadito_10.mid" (2285 bytes)
                const match = line.match(/SUCCESS: "([^"]+)" \((\d+) bytes\)/);
                if (match) {
                    const midiFilePath = match[1];
                    const bytes = parseInt(match[2]);
                    
                    // Max.post(`🔍 Debug: Processing SUCCESS for MIDI: ${midiFilePath}`);
                    
                    // Check if we've already processed this MIDI file
                    if (this.processedMidiFiles.has(midiFilePath)) {
                        // Max.post(`🔍 Debug: ⚠️ MIDI file already processed, skipping: ${midiFilePath}`);
                        continue; // Continue to next line instead of return
                    }
                    
                    // Mark this MIDI file as processed
                    this.processedMidiFiles.add(midiFilePath);
                    
                    // Max.post(`🔍 Debug: Current pending requests: ${Array.from(this.pendingRequests.keys()).map(k => path.basename(k)).join(', ')}`);
                    // Max.post(`🔍 Debug: Processed MIDI files so far: ${Array.from(this.processedMidiFiles).map(p => path.basename(p)).join(', ')}`);
                    
                    // Find the original audio file path by matching filenames
                    let originalFile = null;
                    let matchedRequest = null;
                    
                    // Extract just the filename from the MIDI path for comparison
                    const midiBasename = path.basename(midiFilePath, '.mid');
                    // Max.post(`🔍 Debug: Looking for audio file that would produce MIDI: ${midiBasename}.mid`);
                    
                    for (const [audioPath, requestInfo] of this.pendingRequests.entries()) {
                        // Get what basename the daemon would use for MIDI output
                        const audioBaseName = path.basename(audioPath, path.extname(audioPath));
                        
                        // Max.post(`🔍 Debug: Checking audio: ${path.basename(audioPath)} -> would create: ${audioBaseName}.mid`);
                        
                        // Match by basename - the daemon creates MIDI files with same basename as input
                        if (audioBaseName === midiBasename) {
                            originalFile = audioPath;
                            matchedRequest = requestInfo;
                            // Max.post(`🔍 Debug: ✅ Found match! Audio: ${path.basename(audioPath)} -> MIDI: ${midiBasename}.mid`);
                            break;
                        }
                    }
                    
                    if (originalFile && this.pendingRequests.has(originalFile)) {
                        // Remove from pending requests IMMEDIATELY to prevent race condition
                        this.pendingRequests.delete(originalFile);
                        
                        const { requestId, startTime, fileName, expectedMidiPath, originalBaseName, cleanupFile } = matchedRequest;
                        const processingTime = Date.now() - startTime;
                        
                        // Use the MIDI file as-is, no renaming
                        const finalMidiPath = midiFilePath;
                        
                        Max.post(`✅ Successfully processed: ${fileName} -> ${path.basename(finalMidiPath)} (${bytes} bytes, ${processingTime}ms)`);
                        
                        // Send the final MIDI file path back to Max
                        Max.outlet(finalMidiPath);
                        Max.outlet('processing_complete', fileName, finalMidiPath, bytes, processingTime);
                        
                        // Cleanup preprocessed file if it exists
                        if (cleanupFile && fs.existsSync(cleanupFile)) {
                            fs.unlinkSync(cleanupFile);
                            Max.post(`🗑️ Cleaned up temporary file: ${path.basename(cleanupFile)}`);
                        }
                        
                        // Clean up processed MIDI tracking after a delay to prevent immediate re-processing
                        setTimeout(() => {
                            this.processedMidiFiles.delete(midiFilePath);
                        }, 5000);
                    } else {
                        Max.post(`❌ Debug: No matching pending request found for ${midiFilePath}`);
                        // Max.post(`🔍 Debug: Available pending requests: ${Array.from(this.pendingRequests.keys()).join(', ')}`);
                        // Max.post(`🔍 Debug: Looking for basename: ${midiBasename}`);
                        // Remove from processed set since we couldn't match it
                        this.processedMidiFiles.delete(midiFilePath);
                    }
                }
            } else if (line.startsWith('Error processing')) {
                // Handle error messages
                const match = line.match(/Error processing ([^:]+):/);
                if (match) {
                    const failedFile = match[1];
                    
                    if (this.pendingRequests.has(failedFile)) {
                        const { fileName, cleanupFile } = this.pendingRequests.get(failedFile);
                        
                        Max.post(`❌ Error processing: ${fileName} - ${line}`);
                        Max.outlet('processing_error', fileName, line);
                        
                        // Cleanup preprocessed file if it exists
                        if (cleanupFile && fs.existsSync(cleanupFile)) {
                            fs.unlinkSync(cleanupFile);
                            Max.post(`🗑️ Cleaned up temporary file: ${path.basename(cleanupFile)}`);
                        }
                        
                        this.pendingRequests.delete(failedFile);
                    }
                }
            } else if (line.startsWith('Processing:')) {
                // Handle progress messages
                const match = line.match(/Processing: (.+)/);
                if (match) {
                    const processingFile = match[1];
                    
                    if (this.pendingRequests.has(processingFile)) {
                        const { fileName } = this.pendingRequests.get(processingFile);
                        Max.post(`🔄 Processing: ${fileName}`);
                        Max.outlet('processing_progress', fileName);
                    }
                }
            }
        }
    }
    
    shutdown() {
        Max.post('🛑 Shutting down BasicPitch server...');
        
        if (this.daemonProcess) {
            Max.post('Stopping daemon...');
            this.daemonProcess.stdin.write('quit\n');
            this.daemonProcess.kill();
        }
        
        Max.post('Server shutdown complete.');
        Max.outlet('shutdown');
        process.exit(0);
    }
}

// Create and start the server
const server = new BasicPitchServer();

Max.addHandler('help', () => {
    Max.post('');
    Max.post('🎵 BasicPitch Server for Max - Help');
    Max.post('=====================================');
    Max.post('');
    Max.post('Available Commands:');
    Max.post('  path <audio_file>     - Process audio file');
    Max.post('  preprocess <audio_file> - Process with preprocessing');
    Max.post('  flags <params...>     - Set parameters and restart daemon');
    Max.post('  status               - Check daemon status');
    Max.post('  pending              - Check pending requests count');
    Max.post('  bang                 - Get general info');
    Max.post('  help                 - Show this help');
    Max.post('');
    Max.post('Available Parameters for flags command:');
    Max.post('');
    
    const validations = {
        'onset-threshold': {
            min: 0.0,
            max: 1.0,
            type: 'number',
            description: 'Onset threshold (higher = fewer onsets detected)'
        },
        'frame-threshold': {
            min: 0.0,
            max: 1.0,
            type: 'number',
            description: 'Frame threshold (higher = fewer notes detected)'
        },
        'min-frequency': {
            min: 20.0,
            max: 8000.0,
            type: 'number',
            description: 'Minimum frequency in Hz'
        },
        'max-frequency': {
            min: 20.0,
            max: 8000.0,
            type: 'number',
            description: 'Maximum frequency in Hz'
        },
        'min-note-length': {
            min: 0.01,
            max: 10.0,
            type: 'number',
            description: 'Minimum note length in seconds'
        },
        'tempo-bpm': {
            min: 60.0,
            max: 200.0,
            type: 'number',
            description: 'Tempo in BPM for beat tracking'
        },
        'use-melodia-trick': {
            type: 'boolean',
            description: 'Use melodia trick for better pitch tracking'
        },
        'include-pitch-bends': {
            type: 'boolean',
            description: 'Include pitch bends in MIDI output'
        }
    };

    for (const [param, info] of Object.entries(validations)) {
        if (info.type === 'number') {
            Max.post(`  ${param.padEnd(20)} ${info.type.padEnd(8)} [${info.min}-${info.max}]  ${info.description}`);
        } else {
            Max.post(`  ${param.padEnd(20)} ${info.type.padEnd(8)} [1/0]      ${info.description}`);
        }
    }
    
    Max.post('');
    Max.post('Examples:');
    Max.post('  flags onset-threshold 0.8 frame-threshold 0.3');
    Max.post('  flags use-melodia-trick 1 include-pitch-bends 0');
    Max.post('  flags min-frequency 80 max-frequency 2000 tempo-bpm 120');
    Max.post('');
    
});

Max.addHandler('test_ffmpeg', () => {
    const ffmpegPath = server.findFFmpegPath();
    if (ffmpegPath) {
        Max.post(`✅ ffmpeg found at: ${ffmpegPath}`);
        Max.outlet('ffmpeg_found', ffmpegPath);
    } else {
        Max.post('❌ ffmpeg not found');
        Max.outlet('ffmpeg_not_found');
    }
});

Max.addHandler('shutdown', () => {
    server.shutdown();
});

// Post startup message to Max console
Max.post('🎵 BasicPitch Server for Max started');
Max.post('Waiting for daemon to initialize...');
Max.post('Send help for available commands and parameters');
