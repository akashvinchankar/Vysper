const { desktopCapturer } = require("electron");
const Tesseract = require("tesseract.js");
const fs = require("fs");
const path = require("path");
const logger = require("../core/logger").createServiceLogger("OCR");
const config = require("../core/config");

class OCRService {
  constructor() {
    this.isProcessing = false;
    this.tempFiles = new Set();
  }

  async captureAndProcess() {
    if (this.isProcessing) {
      throw new Error("OCR operation already in progress");
    }

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      logger.info("Starting screenshot capture and OCR processing");

      const screenshot = await this.captureScreenshot();
      const extractedText = await this.performOCR(screenshot);

      logger.logPerformance("OCR processing", startTime, {
        textLength: extractedText.length,
        hasContent: extractedText.trim().length > 0,
      });

      return {
        text: extractedText.trim(),
        metadata: {
          timestamp: new Date().toISOString(),
          source: screenshot.metadata,
          processingTime: Date.now() - startTime,
        },
      };
    } catch (error) {
      logger.error("OCR captureAndProcess failed", {
        error: error.message,
        stack: error.stack,
        processingTime: Date.now() - startTime,
      });
      throw error;
    } finally {
      this.isProcessing = false;
      this.cleanup();
    }
  }

  async captureScreenshot() {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1920, height: 1080 },
      });

      if (sources.length === 0) {
        throw new Error(
          "No screen sources available for capture. Please ensure Screen Recording permission is granted to Vysper in System Preferences > Security & Privacy > Privacy > Screen Recording."
        );
      }

      const primarySource = sources[0];
      const image = primarySource.thumbnail;

      if (!image) {
        throw new Error(
          "Failed to capture screen thumbnail. Check Screen Recording permissions."
        );
      }

      logger.debug("Screenshot captured successfully", {
        sourceName: primarySource.name,
        imageSize: image.getSize(),
      });

      return {
        image,
        metadata: {
          sourceName: primarySource.name,
          dimensions: image.getSize(),
          captureTime: new Date().toISOString(),
        },
      };
    } catch (error) {
      logger.error("Screenshot capture failed", {
        error: error.message,
        stack: error.stack,
      });
      throw new Error(`Screenshot capture failed: ${error.message}`);
    }
  }

  async performOCR(screenshot) {
    let tempPath = null;

    try {
      tempPath = this.createTempFile(screenshot.image);
      logger.debug("Starting OCR text extraction", { tempPath });

      const {
        data: { text },
      } = await Tesseract.recognize(tempPath, config.get("ocr.language"), {
        logger: (progress) => {
          if (progress.status === "recognizing text") {
            logger.debug(
              `OCR progress: ${Math.round(progress.progress * 100)}%`
            );
          }
        },
      });

      const cleanText = this.sanitizeText(text);

      logger.info("OCR text extraction completed", {
        originalLength: text.length,
        cleanedLength: cleanText.length,
        wordsExtracted: cleanText.split(/\s+/).filter((w) => w.length > 0)
          .length,
      });

      return cleanText;
    } catch (error) {
      logger.error("OCR processing failed", {
        error: error.message,
        stack: error.stack,
        tempPath,
        tesseractVersion: await this.getTesseractVersion(),
      });
      throw new Error(
        `Text extraction failed: ${error.message}. Ensure Tesseract is properly installed.`
      );
    }
  }

  async getTesseractVersion() {
    try {
      const { exec } = require("child_process");
      return new Promise((resolve) => {
        exec("tesseract --version", (error, stdout) => {
          if (error) {
            resolve("unknown");
          } else {
            resolve(stdout.split("\n")[0]);
          }
        });
      });
    } catch {
      return "unknown";
    }
  }

  createTempFile(image) {
    const tempPath = path.join(
      config.get("ocr.tempDir"),
      `Vysper-screenshot-${Date.now()}-${Math.random()
        .toString(36)
        .substr(2, 9)}.png`
    );

    const buffer = image.toPNG();
    fs.writeFileSync(tempPath, buffer);

    this.tempFiles.add(tempPath);
    logger.debug("Temporary screenshot file created", {
      tempPath,
      size: buffer.length,
    });

    return tempPath;
  }

  sanitizeText(text) {
    return text
      .replace(/\s+/g, " ")
      .replace(/[^\x20-\x7E\n]/g, "")
      .trim();
  }

  cleanup() {
    for (const tempFile of this.tempFiles) {
      try {
        fs.unlinkSync(tempFile);
        logger.debug("Cleaned up temporary file", { file: tempFile });
      } catch (error) {
        logger.warn("Failed to cleanup temporary file", {
          file: tempFile,
          error: error.message,
        });
      }
    }
    this.tempFiles.clear();
  }

  getStatus() {
    return {
      isProcessing: this.isProcessing,
      tempFilesCount: this.tempFiles.size,
      config: {
        language: config.get("ocr.language"),
        tempDir: config.get("ocr.tempDir"),
      },
    };
  }
}

module.exports = new OCRService();
