const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Max = require('max-api');

class BasicPitchServer {
    constructor() {
        this.daemonProcess = null;
        this.daemonReady = false;
        this.pendingRequests = new Map();
        this.requestCounter = 0;
        
        // Bind methods to preserve 'this' context
        this.processAudioFile = this.processAudioFile.bind(this);
        this.handleDaemonOutput = this.handleDaemonOutput.bind(this);
        this.preprocessAudioFile = this.preprocessAudioFile.bind(this);
        
        // Start the daemon
        this.startDaemon();
        
        // Set up Max API handlers
        this.setupMaxHandlers();
        
        // Handle graceful shutdown
        process.on('SIGINT', this.shutdown.bind(this));
        process.on('SIGTERM', this.shutdown.bind(this));
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
            this.processAudioFile(audioPath);
        });
        
        // Handler for processing with preprocessing
        Max.addHandler('preprocess', (audioPath) => {
            if (!audioPath) {
                Max.post('Error: No audio path provided');
                Max.outlet('error', 'No audio path provided');
                return;
            }
            
            Max.post(`Received preprocess request: ${audioPath}`);
            this.processAudioFile(audioPath, null, true);
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
    }
    
    startDaemon() {
        const cliPath = path.join(__dirname, 'basic-pitch-cli', 'basicpitch_daemon');
        const tempDir = path.join(__dirname, 'temp-midi');
        
        // Create temp directory if it doesn't exist
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        console.log('Starting BasicPitch daemon...');
        this.daemonProcess = spawn(cliPath, ['--daemon', tempDir]);
        
        this.daemonProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            Max.post(`Daemon: ${output}`);
            
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
            Max.post(`Daemon error: ${error}`);
            Max.outlet('daemon_error', error);
        });
        
        this.daemonProcess.on('close', (code) => {
            Max.post(`Daemon exited with code ${code}`);
            Max.outlet('daemon_closed', code);
            this.daemonReady = false;
            this.daemonProcess = null;
        });
        
        this.daemonProcess.on('error', (error) => {
            Max.post(`Failed to start daemon: ${error.message}`);
            Max.outlet('daemon_start_error', error.message);
            this.daemonReady = false;
        });
    }
    
    // Preprocess audio file with ffmpeg to ensure compatibility
    async preprocessAudioFile(inputPath) {
        return new Promise((resolve, reject) => {
            const inputDir = path.dirname(inputPath);
            const inputBaseName = path.basename(inputPath, path.extname(inputPath));
            const preprocessedPath = path.join(inputDir, `${inputBaseName}.tmp.wav`);
            
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
            
            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
            
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
                Max.post(`❌ ffmpeg not found: ${error.message}`);
                reject(error);
            });
        });
    }
    
    async processAudioFile(filePath, requestId = null, usePreprocessing = false) {
        Max.post(`📁 Processing audio file: ${filePath}`);
        
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            const error = `File not found: ${filePath}`;
            Max.post(`❌ Error: ${error}`);
            Max.outlet('error', error, filePath);
            return;
        }
        
        // Check if daemon is ready
        if (!this.daemonReady || !this.daemonProcess) {
            const error = 'Daemon not ready. Please wait for initialization.';
            Max.post(`❌ Error: ${error}`);
            Max.outlet('error', error, filePath);
            return;
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
        const command = `process ${actualFilePath} ${inputDir}\n`;
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
                    
                    // Find the original audio file path by matching the processed file path
                    let originalFile = null;
                    
                    for (const [audioPath, requestInfo] of this.pendingRequests.entries()) {
                        // Check if this MIDI file corresponds to a processed audio file
                        const processedBaseName = path.basename(audioPath, path.extname(audioPath));
                        const midiBaseName = path.basename(midiFilePath, '.mid');
                        
                        if (processedBaseName === midiBaseName) {
                            originalFile = audioPath;
                            break;
                        }
                    }
                    
                    if (originalFile && this.pendingRequests.has(originalFile)) {
                        const { requestId, startTime, fileName, expectedMidiPath, originalBaseName, cleanupFile } = this.pendingRequests.get(originalFile);
                        const processingTime = Date.now() - startTime;
                        
                        let finalMidiPath = midiFilePath;
                        
                        // If the MIDI file has .tmp in the name, rename it to the original basename
                        if (midiFilePath.includes('.tmp.mid')) {
                            const midiDir = path.dirname(midiFilePath);
                            finalMidiPath = path.join(midiDir, `${originalBaseName}.mid`);
                            
                            try {
                                fs.renameSync(midiFilePath, finalMidiPath);
                                Max.post(`📁 Renamed MIDI: ${path.basename(midiFilePath)} -> ${path.basename(finalMidiPath)}`);
                            } catch (error) {
                                Max.post(`❌ Error renaming MIDI file: ${error.message}`);
                                finalMidiPath = midiFilePath; // Use original path if rename fails
                            }
                        }
                        
                        Max.post(`✅ Successfully processed: ${fileName} -> ${path.basename(finalMidiPath)} (${bytes} bytes, ${processingTime}ms)`);
                        
                        // Send the final MIDI file path back to Max
                        Max.outlet(finalMidiPath);
                        Max.outlet('processing_complete', fileName, finalMidiPath, bytes, processingTime);
                        
                        // Cleanup preprocessed file if it exists
                        if (cleanupFile && fs.existsSync(cleanupFile)) {
                            fs.unlinkSync(cleanupFile);
                            Max.post(`🗑️ Cleaned up temporary file: ${path.basename(cleanupFile)}`);
                        }
                        
                        // Remove from pending requests
                        this.pendingRequests.delete(originalFile);
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

// Post startup message to Max console
Max.post('🎵 BasicPitch Server for Max started');
Max.post('Waiting for daemon to initialize...');
Max.post('Send "path /path/to/audio.wav" messages to process audio files');
Max.post('Send "preprocess /path/to/audio.wav" to preprocess problematic files first');
