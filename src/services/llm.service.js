const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require("../core/logger").createServiceLogger("LLM");
const config = require("../core/config");
const { promptLoader } = require("../../prompt-loader");

class LLMService {
  constructor() {
    this.client = null;
    this.model = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;

    // initializeClient may perform async model discovery; don't await here
    this.initializeClient();
  }

  async initializeClient() {
    const apiKey = config.getApiKey("GEMINI");

    if (!apiKey || apiKey === "your-api-key-here") {
      logger.warn("Gemini API key not configured", {
        keyExists: !!apiKey,
        isPlaceholder: apiKey === "your-api-key-here",
      });
      return;
    }

    try {
      this.client = new GoogleGenerativeAI(apiKey);

      // Try to use configured model first
      const configuredModel = config.get("llm.gemini.model");
      try {
        this.model = this.client.getGenerativeModel({ model: configuredModel });
        this.chosenModel = configuredModel;
        this.isInitialized = true;
        logger.info("Gemini AI client initialized successfully", {
          model: this.chosenModel,
        });
        return;
      } catch (modelErr) {
        logger.warn("Configured Gemini model not available", {
          configuredModel,
          error: modelErr.message,
        });
      }

      // Attempt to discover a supported model via ListModels (best-effort)
      const discovered = await this.findSupportedModel(configuredModel);
      if (discovered) {
        try {
          this.model = this.client.getGenerativeModel({ model: discovered });
          this.chosenModel = discovered;
          this.isInitialized = true;
          logger.info("Gemini AI client initialized with discovered model", {
            model: this.chosenModel,
          });
          return;
        } catch (err) {
          logger.error("Failed to initialize discovered model", {
            discovered,
            error: err.message,
          });
        }
      }

      logger.error("No supported Gemini model could be initialized");
    } catch (error) {
      logger.error("Failed to initialize Gemini client", {
        error: error.message,
      });
    }
  }

  async findSupportedModel(preferredName) {
    if (!this.client || typeof this.client.listModels !== "function") {
      logger.warn("Client does not support listModels; cannot discover models");
      return null;
    }

    try {
      const listResult = await this.client.listModels();
      // Normalize to array of model entries
      const models = Array.isArray(listResult) ? listResult : listResult.models || [];

      // Helper to inspect an entry for name and supported methods
      const normalizeEntry = (entry) => {
        return {
          name: entry.name || entry.model || (typeof entry === 'string' ? entry : null),
          methods: entry.supportedMethods || entry.methods || entry.supported || [],
        };
      };

      // Prefer the exact preferredName if present
      for (const m of models) {
        const entry = normalizeEntry(m);
        if (!entry.name) continue;
        if (entry.name.includes(preferredName)) return entry.name;
      }

      // Otherwise find any model that advertises generateContent support
      for (const m of models) {
        const entry = normalizeEntry(m);
        if (!entry.name) continue;
        const methods = Array.isArray(entry.methods) ? entry.methods.map(String) : [];
        if (methods.some((mm) => mm.toLowerCase().includes('generatecontent') || mm.toLowerCase().includes('generate'))) {
          return entry.name;
        }
      }

      // As a last resort, prefer any gemini or bison named model
      for (const m of models) {
        const entry = normalizeEntry(m);
        if (!entry.name) continue;
        if (/gemini|bison/i.test(entry.name)) return entry.name;
      }

      return null;
    } catch (error) {
      logger.warn("Failed to list or discover models", { error: error.message });
      return null;
    }
  }

  async processTextWithSkill(
    text,
    activeSkill,
    sessionMemory = [],
    programmingLanguage = null
  ) {
    if (!this.isInitialized) {
      throw new Error(
        "LLM service not initialized. Check Gemini API key configuration."
      );
    }

    const startTime = Date.now();
    this.requestCount++;

    // Analyze content to determine best response strategy
    const contentAnalysis = this.analyzeContentIntent(text, activeSkill);

    // Use suggested skill if confidence is high and different from current
    let finalSkill = activeSkill;
    if (
      contentAnalysis.confidence > 0.8 &&
      contentAnalysis.suggestedSkill !== activeSkill
    ) {
      finalSkill = contentAnalysis.suggestedSkill;
      logger.info("Content analysis suggested skill change", {
        originalSkill: activeSkill,
        suggestedSkill: finalSkill,
        confidence: contentAnalysis.confidence,
        detectedType: contentAnalysis.type,
        patterns: contentAnalysis.detectedPatterns,
      });
    }

    // Enhance the text with analysis context if available
    let enhancedText = text;
    if (contentAnalysis.enhancedContext) {
      enhancedText = `${contentAnalysis.enhancedContext}\n\nOriginal content:\n${text}`;
    }

    try {
      logger.info("Processing text with LLM", {
        activeSkill: finalSkill,
        originalSkill: activeSkill,
        textLength: text.length,
        enhancedTextLength: enhancedText.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || "not specified",
        requestId: this.requestCount,
        contentType: contentAnalysis.type,
        confidence: contentAnalysis.confidence,
      });

      const geminiRequest = this.buildGeminiRequest(
        enhancedText,
        finalSkill,
        sessionMemory,
        programmingLanguage
      );

      // Try standard method first
      let response;
      try {
        response = await this.executeRequest(geminiRequest);
      } catch (error) {
        // If fetch failed, try alternative method
        if (
          error.message.includes("fetch failed") &&
          config.get("llm.gemini.enableFallbackMethod")
        ) {
          logger.warn("Standard request failed, trying alternative method", {
            error: error.message,
            requestId: this.requestCount,
          });
          response = await this.executeAlternativeRequest(geminiRequest);
        } else {
          throw error;
        }
      }

      logger.logPerformance("LLM text processing", startTime, {
        activeSkill: finalSkill,
        originalSkill: activeSkill,
        textLength: text.length,
        responseLength: response.length,
        programmingLanguage: programmingLanguage || "not specified",
        requestId: this.requestCount,
        contentType: contentAnalysis.type,
      });

      return {
        response,
        metadata: {
          skill: finalSkill,
          originalSkill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          contentAnalysis: {
            type: contentAnalysis.type,
            confidence: contentAnalysis.confidence,
            detectedPatterns: contentAnalysis.detectedPatterns,
          },
        },
      };
    } catch (error) {
      this.errorCount++;
      logger.error("LLM processing failed", {
        error: error.message,
        activeSkill: finalSkill,
        originalSkill: activeSkill,
        programmingLanguage: programmingLanguage || "not specified",
        requestId: this.requestCount,
      });

      if (config.get("llm.gemini.fallbackEnabled")) {
        return this.generateFallbackResponse(text, finalSkill);
      }

      throw error;
    }
  }

  async processTranscriptionWithIntelligentResponse(
    text,
    activeSkill,
    sessionMemory = [],
    programmingLanguage = null
  ) {
    if (!this.isInitialized) {
      throw new Error(
        "LLM service not initialized. Check Gemini API key configuration."
      );
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      logger.info("Processing transcription with intelligent response", {
        activeSkill,
        textLength: text.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || "not specified",
        requestId: this.requestCount,
      });

      const geminiRequest = this.buildIntelligentTranscriptionRequest(
        text,
        activeSkill,
        sessionMemory,
        programmingLanguage
      );

      // Try standard method first
      let response;
      try {
        response = await this.executeRequest(geminiRequest);
      } catch (error) {
        // If fetch failed, try alternative method
        if (
          error.message.includes("fetch failed") &&
          config.get("llm.gemini.enableFallbackMethod")
        ) {
          logger.warn("Standard request failed, trying alternative method", {
            error: error.message,
            requestId: this.requestCount,
          });
          response = await this.executeAlternativeRequest(geminiRequest);
        } else {
          throw error;
        }
      }

      logger.logPerformance("LLM transcription processing", startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: response.length,
        programmingLanguage: programmingLanguage || "not specified",
        requestId: this.requestCount,
      });

      return {
        response,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          isTranscriptionResponse: true,
        },
      };
    } catch (error) {
      this.errorCount++;
      logger.error("LLM transcription processing failed", {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || "not specified",
        requestId: this.requestCount,
      });

      if (config.get("llm.gemini.fallbackEnabled")) {
        return this.generateIntelligentFallbackResponse(text, activeSkill);
      }

      throw error;
    }
  }

  buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    // Check if we have the new conversation history format
    const sessionManager = require("../managers/session.manager");

    if (
      sessionManager &&
      typeof sessionManager.getConversationHistory === "function"
    ) {
      const conversationHistory = sessionManager.getConversationHistory(15);
      const skillContext = sessionManager.getSkillContext(
        activeSkill,
        programmingLanguage
      );
      return this.buildGeminiRequestWithHistory(
        text,
        activeSkill,
        conversationHistory,
        skillContext,
        programmingLanguage
      );
    }

    // Fallback to old method for compatibility - now with programming language support
    const requestComponents = promptLoader.getRequestComponents(
      activeSkill,
      text,
      sessionMemory,
      programmingLanguage
    );

    const request = {
      contents: [],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
        topK: 40,
        topP: 0.95,
      },
    };

    // Use the skill prompt that already has programming language injected
    if (
      requestComponents.shouldUseModelMemory &&
      requestComponents.skillPrompt
    ) {
      request.systemInstruction = {
        parts: [{ text: requestComponents.skillPrompt }],
      };

      logger.debug("Using language-enhanced system instruction for skill", {
        skill: activeSkill,
        programmingLanguage: programmingLanguage || "not specified",
        promptLength: requestComponents.skillPrompt.length,
        requiresProgrammingLanguage:
          requestComponents.requiresProgrammingLanguage,
      });
    }

    request.contents.push({
      role: "user",
      parts: [{ text: this.formatUserMessage(text, activeSkill) }],
    });

    return request;
  }

  buildGeminiRequestWithHistory(
    text,
    activeSkill,
    conversationHistory,
    skillContext,
    programmingLanguage
  ) {
    const request = {
      contents: [],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
        topK: 40,
        topP: 0.95,
      },
    };

    // Use the skill prompt from context (which may already include programming language)
    if (skillContext.skillPrompt) {
      request.systemInstruction = {
        parts: [{ text: skillContext.skillPrompt }],
      };

      logger.debug("Using skill context prompt as system instruction", {
        skill: activeSkill,
        programmingLanguage: programmingLanguage || "not specified",
        promptLength: skillContext.skillPrompt.length,
        requiresProgrammingLanguage:
          skillContext.requiresProgrammingLanguage || false,
        hasLanguageInjection:
          programmingLanguage && skillContext.requiresProgrammingLanguage,
      });
    }

    // Add conversation history (excluding system messages) with validation
    const conversationContents = conversationHistory
      .filter((event) => {
        return (
          event.role !== "system" &&
          event.content &&
          typeof event.content === "string" &&
          event.content.trim().length > 0
        );
      })
      .map((event) => {
        const content = event.content.trim();
        return {
          role: event.role === "model" ? "model" : "user",
          parts: [{ text: content }],
        };
      });

    // Add the conversation history
    request.contents.push(...conversationContents);

    // Format and validate the current user input
    const formattedMessage = this.formatUserMessage(text, activeSkill);
    if (!formattedMessage || formattedMessage.trim().length === 0) {
      throw new Error("Failed to format user message or message is empty");
    }

    // Add the current user input
    request.contents.push({
      role: "user",
      parts: [{ text: formattedMessage }],
    });

    logger.debug("Built Gemini request with conversation history", {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || "not specified",
      historyLength: conversationHistory.length,
      totalContents: request.contents.length,
      hasSystemInstruction: !!request.systemInstruction,
      requiresProgrammingLanguage:
        skillContext.requiresProgrammingLanguage || false,
    });

    return request;
  }

  buildIntelligentTranscriptionRequest(
    text,
    activeSkill,
    sessionMemory,
    programmingLanguage
  ) {
    // Validate input text first
    const cleanText = text && typeof text === "string" ? text.trim() : "";
    if (!cleanText) {
      throw new Error(
        "Empty or invalid transcription text provided to buildIntelligentTranscriptionRequest"
      );
    }

    // Check if we have the new conversation history format
    const sessionManager = require("../managers/session.manager");

    if (
      sessionManager &&
      typeof sessionManager.getConversationHistory === "function"
    ) {
      const conversationHistory = sessionManager.getConversationHistory(10);
      const skillContext = sessionManager.getSkillContext(
        activeSkill,
        programmingLanguage
      );
      return this.buildIntelligentTranscriptionRequestWithHistory(
        cleanText,
        activeSkill,
        conversationHistory,
        skillContext,
        programmingLanguage
      );
    }

    // Fallback to basic intelligent request
    const request = {
      contents: [],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048, // Full responses for transcriptions (same as regular processing)
        topK: 40,
        topP: 0.95,
      },
    };

    // Add intelligent filtering system instruction
    const intelligentPrompt = this.getIntelligentTranscriptionPrompt(
      activeSkill,
      programmingLanguage
    );
    if (!intelligentPrompt) {
      throw new Error("Failed to generate intelligent transcription prompt");
    }

    request.systemInstruction = {
      parts: [{ text: intelligentPrompt }],
    };

    request.contents.push({
      role: "user",
      parts: [{ text: cleanText }],
    });

    logger.debug("Built basic intelligent transcription request", {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || "not specified",
      textLength: cleanText.length,
      hasSystemInstruction: !!request.systemInstruction,
    });

    return request;
  }

  buildIntelligentTranscriptionRequestWithHistory(
    text,
    activeSkill,
    conversationHistory,
    skillContext,
    programmingLanguage
  ) {
    const request = {
      contents: [],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048, // Full responses for transcriptions (same as regular processing)
        topK: 40,
        topP: 0.95,
      },
    };

    // Build intelligent system instruction combining skill prompt and filtering rules
    const intelligentPrompt = this.getIntelligentTranscriptionPrompt(
      activeSkill,
      programmingLanguage
    );
    let combinedInstruction = intelligentPrompt;

    // Use the skill prompt from context (which may already include programming language)
    if (skillContext.skillPrompt) {
      combinedInstruction = `${skillContext.skillPrompt}\n\n${intelligentPrompt}`;
    }

    request.systemInstruction = {
      parts: [{ text: combinedInstruction }],
    };

    // Add recent conversation history (excluding system messages) with validation
    const conversationContents = conversationHistory
      .filter((event) => {
        // Filter out system messages and ensure content exists and is valid
        return (
          event.role !== "system" &&
          event.content &&
          typeof event.content === "string" &&
          event.content.trim().length > 0
        );
      })
      .slice(-8) // Keep last 8 exchanges for context
      .map((event) => {
        const content = event.content.trim();
        if (!content) {
          logger.warn("Empty content found in conversation history", { event });
          return null;
        }
        return {
          role: event.role === "model" ? "model" : "user",
          parts: [{ text: content }],
        };
      })
      .filter((content) => content !== null); // Remove any null entries

    // Add the conversation history
    request.contents.push(...conversationContents);

    // Validate and add the current transcription
    const cleanText = text && typeof text === "string" ? text.trim() : "";
    if (!cleanText) {
      throw new Error("Empty or invalid transcription text provided");
    }

    request.contents.push({
      role: "user",
      parts: [{ text: cleanText }],
    });

    // Ensure we have at least one content item
    if (request.contents.length === 0) {
      throw new Error("No valid content to send to Gemini API");
    }

    logger.debug(
      "Built intelligent transcription request with conversation history",
      {
        skill: activeSkill,
        programmingLanguage: programmingLanguage || "not specified",
        historyLength: conversationHistory.length,
        totalContents: request.contents.length,
        hasSkillPrompt: !!skillContext.skillPrompt,
        cleanTextLength: cleanText.length,
        requiresProgrammingLanguage:
          skillContext.requiresProgrammingLanguage || false,
      }
    );

    return request;
  }

  getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) {
    let prompt = `# Intelligent Transcription Response System

Assume you are asked a question in ${activeSkill.toUpperCase()} mode. Your job is to intelligently respond to question/message with appropriate brevity.
Assume you are in an interview and you need to perform best in ${activeSkill.toUpperCase()} mode.
Always respond to the point, do not repeat the question or unnecessary information which is not related to ${activeSkill}.`;

    // Add programming language context if provided
    if (programmingLanguage) {
      prompt += `\n\nCODING CONTEXT: When providing code examples or technical solutions, use ${programmingLanguage.toUpperCase()} as the primary programming language.`;
    }

    prompt += `

## Response Rules:

### If the transcription is casual conversation, greetings, or NOT related to ${activeSkill}:
- Respond with: "Yeah, I'm listening. Ask your question relevant to ${activeSkill}."
- Or similar brief acknowledgments like: "I'm here, what's your ${activeSkill} question?"

### If the transcription IS relevant to ${activeSkill} or is a follow-up question:
- Provide a comprehensive, detailed response
- Use bullet points, examples, and explanations
- Focus on actionable insights and complete answers
- Do not truncate or shorten your response

### Examples of casual/irrelevant messages:
- "Hello", "Hi there", "How are you?"
- "What's the weather like?"
- "I'm just testing this"
- Random conversations not related to ${activeSkill}

### Examples of relevant messages:
- Actual questions about ${activeSkill} concepts
- Follow-up questions to previous responses
- Requests for clarification on ${activeSkill} topics
- Problem-solving requests related to ${activeSkill}

## Response Format:
- Keep responses detailed
- Use bullet points for structured answers
- Be encouraging and helpful
- Stay focused on ${activeSkill}

Remember: Be intelligent about filtering - only provide detailed responses when the user actually needs help with ${activeSkill}.`;

    return prompt;
  }

  formatUserMessage(text, activeSkill) {
    return `Context: ${activeSkill.toUpperCase()} analysis request\n\nText to analyze:\n${text}`;
  }

  async executeRequest(geminiRequest) {
    const maxRetries = config.get("llm.gemini.maxRetries");
    const timeout = config.get("llm.gemini.timeout");

    // Add request debugging
    logger.debug("Executing Gemini request", {
      hasModel: !!this.model,
      hasClient: !!this.client,
      requestKeys: Object.keys(geminiRequest),
      timeout,
      maxRetries,
      nodeVersion: process.version,
      platform: process.platform,
    });

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Pre-flight check
        await this.performPreflightCheck();

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Request timeout")), timeout)
        );

        logger.debug(`Gemini API attempt ${attempt} starting`, {
          timestamp: new Date().toISOString(),
          timeout,
        });

        const requestPromise = this.model.generateContent(geminiRequest);
        const result = await Promise.race([requestPromise, timeoutPromise]);

        if (!result.response) {
          throw new Error("Empty response from Gemini API");
        }

        const responseText = result.response.text();

        if (!responseText || responseText.trim().length === 0) {
          throw new Error("Empty text content in Gemini response");
        }

        logger.debug("Gemini API request successful", {
          attempt,
          responseLength: responseText.length,
        });

        return responseText.trim();
      } catch (error) {
        const errorInfo = this.analyzeError(error);

        // Enhanced error logging for fetch failures
        if (errorInfo.type === "NETWORK_ERROR") {
          logger.error("Network error details", {
            attempt,
            errorMessage: error.message,
            errorStack: error.stack,
            errorName: error.name,
            nodeEnv: process.env.NODE_ENV,
            electronVersion: process.versions.electron,
            chromeVersion: process.versions.chrome,
            nodeVersion: process.versions.node,
            userAgent: this.getUserAgent(),
          });
        }

        logger.warn(`Gemini API attempt ${attempt} failed`, {
          error: error.message,
          errorType: errorInfo.type,
          isNetworkError: errorInfo.isNetworkError,
          suggestedAction: errorInfo.suggestedAction,
          remainingAttempts: maxRetries - attempt,
        });

        if (attempt === maxRetries) {
          const finalError = new Error(
            `Gemini API failed after ${maxRetries} attempts: ${error.message}`
          );
          finalError.errorAnalysis = errorInfo;
          finalError.originalError = error;
          throw finalError;
        }

        // Use exponential backoff with jitter for network errors
        const baseDelay = errorInfo.isNetworkError ? 2000 : 1000;
        const delay = baseDelay * attempt + Math.random() * 1000;

        logger.debug(`Waiting ${delay}ms before retry ${attempt + 1}`, {
          baseDelay,
          isNetworkError: errorInfo.isNetworkError,
        });

        await this.delay(delay);
      }
    }
  }

  async performPreflightCheck() {
    // Quick connectivity check
    try {
      const startTime = Date.now();
      await this.testNetworkConnection({
        host: "generativelanguage.googleapis.com",
        port: 443,
        name: "Gemini API Endpoint",
      });
      const latency = Date.now() - startTime;

      logger.debug("Preflight check passed", { latency });
    } catch (error) {
      logger.warn("Preflight check failed", {
        error: error.message,
        suggestion: "Network connectivity issue detected before API call",
      });
      // Don't throw here - let the actual API call fail with more detail
    }
  }

  getUserAgent() {
    try {
      // Try to get user agent from Electron if available
      if (typeof navigator !== "undefined" && navigator.userAgent) {
        return navigator.userAgent;
      }
      return `Node.js/${process.version} (${process.platform}; ${process.arch})`;
    } catch {
      return "Unknown";
    }
  }

  analyzeError(error) {
    const errorMessage = error.message.toLowerCase();

    // Network connectivity errors
    if (
      errorMessage.includes("fetch failed") ||
      errorMessage.includes("network error") ||
      errorMessage.includes("enotfound") ||
      errorMessage.includes("econnrefused") ||
      errorMessage.includes("timeout")
    ) {
      return {
        type: "NETWORK_ERROR",
        isNetworkError: true,
        suggestedAction: "Check internet connection and firewall settings",
      };
    }

    // API key errors
    if (
      errorMessage.includes("unauthorized") ||
      errorMessage.includes("invalid api key") ||
      errorMessage.includes("forbidden")
    ) {
      return {
        type: "AUTH_ERROR",
        isNetworkError: false,
        suggestedAction: "Verify Gemini API key configuration",
      };
    }

    // Rate limiting
    if (
      errorMessage.includes("quota") ||
      errorMessage.includes("rate limit") ||
      errorMessage.includes("too many requests")
    ) {
      return {
        type: "RATE_LIMIT_ERROR",
        isNetworkError: false,
        suggestedAction: "Wait before retrying or check API quota",
      };
    }

    // Timeout errors
    if (errorMessage.includes("request timeout")) {
      return {
        type: "TIMEOUT_ERROR",
        isNetworkError: true,
        suggestedAction: "Check network latency or increase timeout",
      };
    }

    return {
      type: "UNKNOWN_ERROR",
      isNetworkError: false,
      suggestedAction: "Check logs for more details",
    };
  }

  async checkNetworkConnectivity() {
    const connectivityTests = [
      { host: "google.com", port: 443, name: "Google (HTTPS)" },
      {
        host: "generativelanguage.googleapis.com",
        port: 443,
        name: "Gemini API Endpoint",
      },
    ];

    const results = await Promise.allSettled(
      connectivityTests.map((test) => this.testNetworkConnection(test))
    );

    const connectivity = {
      timestamp: new Date().toISOString(),
      tests: results.map((result, index) => ({
        ...connectivityTests[index],
        success: result.status === "fulfilled" && result.value,
        error: result.status === "rejected" ? result.reason.message : null,
      })),
    };

    logger.info("Network connectivity check completed", connectivity);
    return connectivity;
  }

  async testNetworkConnection({ host, port, name }) {
    return new Promise((resolve, reject) => {
      const net = require("net");
      const socket = new net.Socket();

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, 5000);

      socket.on("connect", () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.on("error", (error) => {
        clearTimeout(timeout);
        reject(
          new Error(`Connection failed to ${host}:${port}: ${error.message}`)
        );
      });

      socket.connect(port, host);
    });
  }

  generateFallbackResponse(text, activeSkill) {
    logger.info("Generating fallback response", { activeSkill });

    const fallbackResponses = {
      dsa: "This appears to be a data structures and algorithms problem. Consider breaking it down into smaller components and identifying the appropriate algorithm or data structure to use.",
      "system-design":
        "For this system design question, consider scalability, reliability, and the trade-offs between different architectural approaches.",
      programming:
        "This looks like a programming challenge. Focus on understanding the requirements, edge cases, and optimal time/space complexity.",
      default:
        "I can help analyze this content. Please ensure your Gemini API key is properly configured for detailed analysis.",
    };

    const response =
      fallbackResponses[activeSkill] || fallbackResponses.default;

    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true,
      },
    };
  }

  generateIntelligentFallbackResponse(text, activeSkill) {
    logger.info("Generating intelligent fallback response for transcription", {
      activeSkill,
    });

    // Simple heuristic to determine if message seems skill-related
    const skillKeywords = {
      dsa: [
        "algorithm",
        "data structure",
        "array",
        "tree",
        "graph",
        "sort",
        "search",
        "complexity",
        "big o",
      ],
      programming: [
        "code",
        "function",
        "variable",
        "class",
        "method",
        "bug",
        "debug",
        "syntax",
      ],
      "system-design": [
        "scalability",
        "database",
        "architecture",
        "microservice",
        "load balancer",
        "cache",
      ],
      behavioral: [
        "interview",
        "experience",
        "situation",
        "leadership",
        "conflict",
        "team",
      ],
      reactjs: ["react", "component", "jsx", "hook", "state", "props", "redux"],
      "react-machine-coding": [
        "react",
        "component",
        "build",
        "create",
        "implement",
        "machine",
        "coding",
        "todo",
        "form",
        "list",
        "table",
        "calculator",
        "app",
        "application",
      ],
      "frontend-interview": [
        "explain",
        "what is",
        "how does",
        "difference between",
        "why",
        "when",
        "interview",
        "question",
        "concept",
        "theory",
        "definition",
        "advantages",
        "disadvantages",
        "compare",
      ],
      webdevelopment: [
        "html",
        "css",
        "javascript",
        "frontend",
        "backend",
        "ui",
        "ux",
        "responsive",
      ],
      devops: [
        "deployment",
        "ci/cd",
        "docker",
        "kubernetes",
        "infrastructure",
        "monitoring",
      ],
    };

    const textLower = text.toLowerCase();
    const relevantKeywords = skillKeywords[activeSkill] || [];
    const hasRelevantKeywords = relevantKeywords.some((keyword) =>
      textLower.includes(keyword)
    );

    // Check for question indicators
    const questionIndicators = [
      "how",
      "what",
      "why",
      "when",
      "where",
      "can you",
      "could you",
      "should i",
      "?",
    ];
    const seemsLikeQuestion = questionIndicators.some((indicator) =>
      textLower.includes(indicator)
    );

    let response;
    if (hasRelevantKeywords || seemsLikeQuestion) {
      response = `I'm having trouble processing that right now, but it sounds like a ${activeSkill} question. Could you rephrase or ask more specifically about what you need help with?`;
    } else {
      response = `Yeah, I'm listening. Ask your question relevant to ${activeSkill}.`;
    }

    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true,
        isTranscriptionResponse: true,
      },
    };
  }

  async testConnection() {
    if (!this.isInitialized) {
      return { success: false, error: "Service not initialized" };
    }

    try {
      // First check network connectivity
      const networkCheck = await this.checkNetworkConnectivity();
      const hasNetworkIssues = networkCheck.tests.some((test) => !test.success);

      if (hasNetworkIssues) {
        logger.warn("Network connectivity issues detected", networkCheck);
      }

      const testRequest = {
        contents: [
          {
            role: "user",
            parts: [{ text: 'Test connection. Please respond with "OK".' }],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 10,
        },
      };

      const startTime = Date.now();
      const result = await this.model.generateContent(testRequest);
      const latency = Date.now() - startTime;
      const response = result.response.text();

      logger.info("Connection test successful", {
        response,
        latency,
        networkCheck: hasNetworkIssues ? "issues_detected" : "healthy",
      });

      return {
        success: true,
        response: response.trim(),
        latency,
        networkConnectivity: networkCheck,
      };
    } catch (error) {
      const errorAnalysis = this.analyzeError(error);
      logger.error("Connection test failed", {
        error: error.message,
        errorAnalysis,
      });

      return {
        success: false,
        error: error.message,
        errorAnalysis,
        networkConnectivity: await this.checkNetworkConnectivity().catch(
          () => null
        ),
      };
    }
  }

  updateApiKey(newApiKey) {
    process.env.GEMINI_API_KEY = newApiKey;
    this.isInitialized = false;
    this.initializeClient();

    logger.info("API key updated and client reinitialized");
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate:
        this.requestCount > 0
          ? ((this.requestCount - this.errorCount) / this.requestCount) * 100
          : 0,
      config: config.get("llm.gemini"),
    };
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async executeAlternativeRequest(geminiRequest) {
    const https = require("https");
    const apiKey = config.getApiKey("GEMINI");
    // Prefer any discovered/initialized model name; fallback to config
    const model = this.chosenModel || config.get("llm.gemini.model");

    logger.info("Using alternative HTTPS request method");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const postData = JSON.stringify(geminiRequest);

    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
        "User-Agent": this.getUserAgent(),
      },
      timeout: config.get("llm.gemini.timeout"),
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            if (res.statusCode !== 200) {
              // Provide a clearer message for 404 model not found
              if (res.statusCode === 404 && data && data.includes('models')) {
                reject(
                  new Error(
                    `HTTP ${res.statusCode}: ${data} - This often means the model ${model} is not available for v1beta generateContent. Consider updating the model name or calling ListModels to discover supported models.`
                  )
                );
                return;
              }

              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              return;
            }

            const response = JSON.parse(data);

            if (
              !response.candidates ||
              !response.candidates[0] ||
              !response.candidates[0].content
            ) {
              reject(new Error("Invalid response structure from Gemini API"));
              return;
            }

            const text = response.candidates[0].content.parts[0].text;

            if (!text || text.trim().length === 0) {
              reject(new Error("Empty text content in Gemini response"));
              return;
            }

            logger.info("Alternative request successful", {
              responseLength: text.length,
              statusCode: res.statusCode,
            });

            resolve(text.trim());
          } catch (parseError) {
            reject(
              new Error(`Failed to parse response: ${parseError.message}`)
            );
          }
        });
      });

      req.on("error", (error) => {
        reject(new Error(`Alternative request failed: ${error.message}`));
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Alternative request timeout"));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Analyzes content to detect what type of response is needed
   * @param {string} text - The input text (from OCR or user input)
   * @param {string} currentSkill - The currently active skill
   * @returns {Object} Analysis result with detected intent and enhanced context
   */
  analyzeContentIntent(text, currentSkill) {
    const analysis = {
      type: "unknown",
      confidence: 0,
      enhancedContext: "",
      suggestedSkill: currentSkill,
      detectedPatterns: [],
    };

    const lowerText = text.toLowerCase();

    // DSA Input/Output Pattern Detection - GENERALIZED
    const inputOutputPatterns = [
      {
        // Explicit Input/Output format
        pattern: /input:\s*[\w\s=\[\],\-\d"']+.*?output:\s*[\w\s\[\],\-\d"']+/is,
        problem: "explicit input/output problem",
        skill: "dsa",
        confidence: 0.95,
        context: "This is a clear algorithm problem with explicit input/output format. I'll analyze the pattern and provide both brute force and optimal solutions."
      },
      {
        // Array patterns without explicit labels - common interview formats
        pattern: /(?:given|find|return).*array.*\[[\d,\s\-]+\]|array.*\[[\d,\s\-]+\].*(?:find|return|output)/is,
        problem: "array algorithm",
        skill: "dsa",
        confidence: 0.9,
        context: "This appears to be an array algorithm problem. I'll determine the required operation and implement both brute force and optimal solutions."
      },
      {
        // String patterns without explicit labels
        pattern: /(?:given|find|return).*string.*["'][^"']*["']|string.*["'][^"']*["'].*(?:find|return|output)/is,
        problem: "string algorithm",
        skill: "dsa",
        confidence: 0.85,
        context: "This looks like a string processing problem. I'll analyze the requirements and provide complete solutions."
      },
      {
        // Number sequences or mathematical patterns
        pattern: /\[[\d,\s\-]+\].*(?:sum|max|min|count|find)|(?:sum|max|min|count|find).*\[[\d,\s\-]+\]/is,
        problem: "numerical algorithm",
        skill: "dsa",
        confidence: 0.85,
        context: "This appears to be a numerical/mathematical algorithm problem. I'll analyze the pattern and implement solutions."
      },
      {
        // Tree/Binary tree patterns
        pattern: /tree|binary.tree|root.*node|node.*tree|traverse|inorder|preorder|postorder/is,
        problem: "tree algorithm",
        skill: "dsa",
        confidence: 0.9,
        context: "This is a tree-related algorithm problem. I'll implement the appropriate tree traversal or manipulation solution."
      },
      {
        // Graph patterns
        pattern: /graph|vertex|edge|node.*connect|path|shortest|cycle|dfs|bfs/is,
        problem: "graph algorithm",
        skill: "dsa",
        confidence: 0.9,
        context: "This is a graph algorithm problem. I'll implement the appropriate graph traversal or pathfinding solution."
      },
      {
        // Sliding window patterns (without explicit input/output)
        pattern: /sliding.window|subarray|substring|window.*size|maximum.*window|minimum.*window/is,
        problem: "sliding window algorithm",
        skill: "dsa",
        confidence: 0.85,
        context: "This appears to be a sliding window technique problem. I'll implement both brute force and optimal sliding window solutions."
      },
      {
        // Two pointer patterns
        pattern: /two.pointer|left.*right|start.*end|beginning.*end|palindrome|reverse/is,
        problem: "two pointer algorithm",
        skill: "dsa",
        confidence: 0.8,
        context: "This looks like a two-pointer technique problem. I'll implement solutions using the two-pointer approach."
      },
      {
        // Dynamic Programming patterns
        pattern: /dynamic.programming|dp|memoization|optimal.*way|minimum.*steps|maximum.*profit|fibonacci|climbing/is,
        problem: "dynamic programming",
        skill: "dsa",
        confidence: 0.85,
        context: "This is a dynamic programming problem. I'll provide both recursive and iterative solutions with memoization."
      },
      {
        // Common algorithm keywords
        pattern: /sort|search|merge|find.*pair|two.sum|three.sum|binary.search|quick.sort|merge.sort/is,
        problem: "classical algorithm",
        skill: "dsa",
        confidence: 0.8,
        context: "This is a classical algorithm problem. I'll implement the standard approach with optimizations."
      },
      {
        // Mathematical/logical patterns with numbers
        pattern: /\d+.*\d+.*(?:equal|sum|difference|product)|(?:even|odd).*number|prime.*number|factorial/is,
        problem: "mathematical algorithm",
        skill: "dsa",
        confidence: 0.75,
        context: "This appears to be a mathematical algorithm problem. I'll analyze the numerical pattern and provide solutions."
      },
      {
        // Generic problem-solving patterns
        pattern: /given.*find|given.*return|implement.*function|write.*algorithm|solve.*problem/is,
        problem: "general algorithm",
        skill: "dsa",
        confidence: 0.7,
        context: "This is an algorithm problem. I'll analyze the requirements and provide both brute force and optimal solutions."
      }
    ];

    // Check for input/output patterns first (highest priority)
    for (const {pattern, problem, skill, confidence, context} of inputOutputPatterns) {
      if (pattern.test(text)) {
        analysis.type = "leetcode_problem";
        analysis.confidence = confidence;
        analysis.suggestedSkill = skill;
        analysis.detectedPatterns.push(`${problem}_pattern`);
        analysis.enhancedContext = `${context}\n\nImplement the complete solution in JavaScript with optimal time complexity.`;
        return analysis;
      }
    }

    // Task name patterns for different skills
    const taskPatterns = {
      "react-machine-coding": [
        "todo app",
        "task manager",
        "accordion",
        "modal",
        "popup",
        "dropdown",
        "carousel",
        "slider",
        "tabs",
        "pagination",
        "file upload",
        "image gallery",
        "search bar",
        "table",
        "data grid",
        "chart",
        "graph",
        "dashboard",
        "timeline",
        "calendar",
        "comments system",
        "calculator",
        "weather app",
        "shopping cart",
        "chat app",
        "form builder",
        "kanban board",
        "music player",
        "photo editor",
        "nested folder structure",
        "file manager",
        "json viewer",
        "text editor",
        "code editor",
      ],
      "frontend-interview": [
        "explain",
        "what is",
        "how does",
        "difference between",
        "why",
        "when",
        "advantages of",
        "disadvantages of",
        "compare",
        "vs",
        "benefits",
        "virtual dom",
        "reconciliation",
        "state management",
        "props",
        "hooks",
        "lifecycle",
        "context api",
        "redux",
        "css modules",
        "styled components",
        "webpack",
        "babel",
        "event loop",
        "closure",
        "hoisting",
        "prototype",
        "asynchronous",
        "promise",
        "async await",
        "this binding",
        "arrow function",
        "flexbox",
        "grid",
        "responsive design",
        "accessibility",
        "performance",
        "optimization",
        "bundle",
        "code splitting",
        "lazy loading",
        "memoization",
      ],
      dsa: [
        "two sum",
        "3sum",
        "maximum subarray",
        "sliding window",
        "sliding window maximum",
        "merge intervals",
        "binary tree traversal",
        "lowest common ancestor",
        "tree serialization",
        "valid bst",
        "tree diameter",
        "graph traversal",
        "shortest path",
        "cycle detection",
        "topological sort",
        "connected components",
        "fibonacci",
        "climbing stairs",
        "coin change",
        "longest subsequence",
        "knapsack",
        "edit distance",
        "merge sort",
        "quick sort",
        "binary search",
      ],
      programming: [
        "implement",
        "create function",
        "write algorithm",
        "build class",
        "design pattern",
        "api endpoint",
        "database query",
        "optimization",
      ],
    };

    // Code completion patterns
    const codePatterns = [
      /function\s+\w+\s*\([^)]*\)\s*\{?\s*$/, // Incomplete function
      /class\s+\w+\s*\{[^}]*$/, // Incomplete class
      /def\s+\w+\s*\([^)]*\):\s*$/, // Python function stub
      /const\s+\w+\s*=\s*\([^)]*\)\s*=>\s*$/, // Arrow function stub
      /\/\/\s*TODO/i, // TODO comments
      /\/\*.*\*\//, // Block comments (potential pseudocode)
      /\s+\.\.\.\s*$/, // Ellipsis indicating incomplete code
    ];

    // Check for task name patterns
    for (const [skill, patterns] of Object.entries(taskPatterns)) {
      for (const pattern of patterns) {
        if (lowerText.includes(pattern)) {
          analysis.type = "task_implementation";
          analysis.confidence = Math.max(analysis.confidence, 0.8);
          analysis.suggestedSkill = skill;
          analysis.detectedPatterns.push(pattern);
          analysis.enhancedContext = `Implement a complete ${pattern} application.`;
          break;
        }
      }
    }

    // Check for incomplete code patterns
    for (const pattern of codePatterns) {
      if (pattern.test(text)) {
        analysis.type = "code_completion";
        analysis.confidence = Math.max(analysis.confidence, 0.9);
        analysis.detectedPatterns.push("incomplete_code");
        analysis.enhancedContext =
          "Complete the incomplete code implementation.";
        break;
      }
    }

    // Check for specific programming language syntax
    const languagePatterns = {
      javascript: [
        /import.*from/,
        /const.*=.*require/,
        /function.*\{/,
        /=>/,
        /console\.log/,
      ],
      python: [/import.*/, /def.*:/, /class.*:/, /print\(/, /if.*:/],
      java: [
        /public class/,
        /public static void/,
        /System\.out\./,
        /import java/,
      ],
      cpp: [/#include/, /using namespace/, /int main\(/, /cout.*<</, /std::/],
      react: [/import.*react/i, /usestate/i, /useeffect/i, /jsx/, /component/i],
    };

    for (const [lang, patterns] of Object.entries(languagePatterns)) {
      if (patterns.some((pattern) => pattern.test(lowerText))) {
        analysis.detectedPatterns.push(`${lang}_syntax`);
        if (lang === "react" && !analysis.suggestedSkill.includes("react")) {
          analysis.suggestedSkill = "react-machine-coding";
        }
      }
    }

    // If no specific patterns detected but text looks like a question or request
    if (analysis.type === "unknown") {
      if (
        lowerText.includes("how") ||
        lowerText.includes("what") ||
        lowerText.includes("?")
      ) {
        analysis.type = "question";
        analysis.confidence = 0.7;
      } else if (lowerText.length > 20) {
        analysis.type = "general_request";
        analysis.confidence = 0.6;
      }
    }

    return analysis;
  }
}

module.exports = new LLMService();
