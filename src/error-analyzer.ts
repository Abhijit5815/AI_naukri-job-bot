import { Ollama } from 'ollama';
import { Page } from 'playwright';

export interface ErrorAnalysis {
  errorType: 'timeout' | 'locator' | 'network' | 'captcha' | 'ui_change' | 'unknown';
  severity: 'low' | 'medium' | 'high';
  suggestedFixes: string[];
  alternativeLocators: string[];
  shouldRetry: boolean;
  retryDelay: number;
}

export interface FixAttempt {
  strategy: string;
  success: boolean;
  newLocator?: string;
  notes: string;
}

export class ErrorAnalysisEngine {
  private llm: Ollama;
  private page: Page;
  private errorHistory: Map<string, number> = new Map();
  private successfulFixes: Map<string, string> = new Map();

  constructor(page: Page) {
    this.llm = new Ollama({
      host: 'http://localhost:11434'
    });
    this.page = page;
  }

  async analyzeError(error: Error, context: string, currentUrl: string, screenshot?: Buffer): Promise<ErrorAnalysis> {
    const errorMessage = error.message;
    const stackTrace = error.stack || '';
    
    // Get current page state with proper error handling
    const pageTitle = await this.page.title().catch(() => 'Unknown');
    const pageHtml = await this.page.content().catch(() => '');
    const visibleElements = await this.getVisibleElements();

    const analysisPrompt = `
You are an expert automation engineer analyzing a web scraping/automation failure. Analyze this error and provide solutions.

ERROR CONTEXT:
- Action: ${context}
- URL: ${currentUrl}
- Page Title: ${pageTitle}
- Error Message: ${errorMessage}
- Stack Trace: ${stackTrace}

CURRENT PAGE STATE:
- Visible Elements: ${visibleElements.slice(0, 10).join(', ')}
- Has Login Forms: ${pageHtml.includes('password') || pageHtml.includes('login')}
- Has Job Listings: ${pageHtml.includes('jobTuple') || pageHtml.includes('job')}
- Has CAPTCHA: ${pageHtml.includes('captcha') || pageHtml.includes('recaptcha')}

PREVIOUS ERRORS:
${Array.from(this.errorHistory.entries()).map(([err, count]) => `${err}: ${count} times`).join('\n')}

Analyze and respond in JSON format:
{
  "errorType": "timeout|locator|network|captcha|ui_change|unknown",
  "severity": "low|medium|high",
  "suggestedFixes": ["fix1", "fix2", "fix3"],
  "alternativeLocators": ["locator1", "locator2", "locator3"],
  "shouldRetry": true,
  "retryDelay": 5000
}

Focus on practical solutions for Naukri.com job application automation.
`;

    try {
      const response = await this.llm.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: analysisPrompt }],
        stream: false
      });

      const jsonMatch = response.message.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const analysis = JSON.parse(jsonMatch[0]) as ErrorAnalysis;
        this.logError(errorMessage);
        return analysis;
      }
    } catch (llmError) {
      const error = llmError as Error; // Type assertion for error handling
      console.log(`⚠️ LLM analysis failed: ${error.message}`);
    }

    // Fallback analysis
    return this.fallbackErrorAnalysis(errorMessage, context);
  }

  async attemptFix(error: Error, analysis: ErrorAnalysis, context: string): Promise<FixAttempt> {
    console.log(`🔧 Attempting to fix error: ${error.message}`);
    console.log(`🎯 Strategy: ${analysis.suggestedFixes[0]}`);

    for (const fix of analysis.suggestedFixes) {
      try {
        const result = await this.applyFix(fix, analysis, context);
        if (result.success) {
          console.log(`✅ Fix successful: ${result.strategy}`);
          if (result.newLocator) {
            this.successfulFixes.set(context, result.newLocator);
          }
          return result;
        }
      } catch (fixError) {
        const error = fixError as Error; // Type assertion
        console.log(`❌ Fix failed: ${fix} - ${error.message}`);
        continue;
      }
    }

    return {
      strategy: 'All fixes failed',
      success: false,
      notes: 'Manual intervention required'
    };
  }

  private async applyFix(fix: string, analysis: ErrorAnalysis, context: string): Promise<FixAttempt> {
    switch (analysis.errorType) {
      case 'timeout':
        return await this.fixTimeout(fix, context);
      
      case 'locator':
        return await this.fixLocator(fix, analysis.alternativeLocators, context);
      
      case 'ui_change':
        return await this.fixUIChange(fix, context);
      
      case 'network':
        return await this.fixNetworkIssue(fix);
      
      case 'captcha':
        return await this.fixCaptcha(fix);
      
      default:
        return {
          strategy: fix,
          success: false,
          notes: 'Unknown error type'
        };
    }
  }

  private async fixTimeout(fix: string, context: string): Promise<FixAttempt> {
    if (fix.includes('increase timeout')) {
      await this.page.waitForTimeout(5000);
      return {
        strategy: 'Increased timeout',
        success: true,
        notes: 'Added 5 second delay'
      };
    }

    if (fix.includes('wait for load')) {
      await this.page.waitForLoadState('domcontentloaded', { timeout: 60000 });
      return {
        strategy: 'Wait for DOM content loaded',
        success: true,
        notes: 'Waited for DOM to load'
      };
    }

    if (fix.includes('retry navigation')) {
      await this.page.reload({ waitUntil: 'networkidle' });
      return {
        strategy: 'Page reload',
        success: true,
        notes: 'Reloaded page'
      };
    }

    return {
      strategy: fix,
      success: false,
      notes: 'Timeout fix not implemented'
    };
  }

  private async fixLocator(fix: string, alternativeLocators: string[], context: string): Promise<FixAttempt> {
    // Try alternative locators
    for (const locator of alternativeLocators) {
      try {
        const element = this.page.locator(locator).first();
        if (await element.isVisible({ timeout: 5000 })) {
          return {
            strategy: `Alternative locator: ${locator}`,
            success: true,
            newLocator: locator,
            notes: `Found working locator: ${locator}`
          };
        }
      } catch (locatorError) {
        continue;
      }
    }

    // Try intelligent locator discovery
    if (context.includes('login')) {
      const loginLocators = [
        '#usernameField, #emailField, [name="email"], [type="email"]',
        '#passwordField, [name="password"], [type="password"]',
        'button[type="submit"], .login-btn, #loginButton'
      ];
      
      for (const locator of loginLocators) {
        try {
          if (await this.page.locator(locator).first().isVisible({ timeout: 2000 })) {
            return {
              strategy: `Smart login locator: ${locator}`,
              success: true,
              newLocator: locator,
              notes: `Discovered login element: ${locator}`
            };
          }
        } catch (e) { continue; }
      }
    }

    if (context.includes('job') || context.includes('apply')) {
      const jobLocators = [
        '.jobTuple, .job-card, .job-listing',
        'button:has-text("Apply"), a:has-text("Apply"), .apply-btn',
        '.job-title, .title, h2, h3'
      ];
      
      for (const locator of jobLocators) {
        try {
          if (await this.page.locator(locator).first().isVisible({ timeout: 2000 })) {
            return {
              strategy: `Smart job locator: ${locator}`,
              success: true,
              newLocator: locator,
              notes: `Discovered job element: ${locator}`
            };
          }
        } catch (e) { continue; }
      }
    }

    return {
      strategy: 'Locator discovery failed',
      success: false,
      notes: 'No working alternative locators found'
    };
  }

  private async fixUIChange(fix: string, context: string): Promise<FixAttempt> {
    // Take screenshot for analysis
    const screenshot = await this.page.screenshot({ fullPage: true });
    
    // Use LLM to analyze the current UI and suggest new approach
    const currentUrl = this.page.url();
    const pageTitle = await this.page.title();
    
    const uiAnalysisPrompt = `
The UI has changed. Analyze this context and suggest new element selectors:
Context: ${context}
Current URL: ${currentUrl}
Page Title: ${pageTitle}

Common Naukri.com elements:
- Login: #usernameField, #passwordField, button[type="submit"]
- Jobs: .jobTuple, .title, .companyInfo
- Apply: button:has-text("Apply"), .apply

Suggest 3 alternative selectors for: ${context}
`;

    try {
      const response = await this.llm.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: uiAnalysisPrompt }]
      });

      // Extract suggested selectors from response
      const selectors = this.extractSelectorsFromText(response.message.content);
      
      for (const selector of selectors) {
        try {
          if (await this.page.locator(selector).first().isVisible({ timeout: 3000 })) {
            return {
              strategy: `UI change adaptation: ${selector}`,
              success: true,
              newLocator: selector,
              notes: `Adapted to UI change with: ${selector}`
            };
          }
        } catch (e) { continue; }
      }
    } catch (e) {
      console.log('LLM UI analysis failed');
    }

    return {
      strategy: 'UI change adaptation',
      success: false,
      notes: 'Could not adapt to UI changes'
    };
  }

  private async fixNetworkIssue(fix: string): Promise<FixAttempt> {
    if (fix.includes('retry')) {
      await this.page.waitForTimeout(5000);
      await this.page.reload({ waitUntil: 'networkidle', timeout: 60000 });
      return {
        strategy: 'Network retry',
        success: true,
        notes: 'Reloaded page after network delay'
      };
    }

    return {
      strategy: 'Network fix',
      success: false,
      notes: 'Network issue not resolved'
    };
  }

  private async fixCaptcha(fix: string): Promise<FixAttempt> {
    console.log('🤖 CAPTCHA detected! Pausing for manual intervention...');
    console.log('Please solve the CAPTCHA in the browser and press Enter to continue.');
    
    // Wait for manual intervention
    await new Promise<void>(resolve => {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      rl.question('Press Enter after solving CAPTCHA: ', () => {
        rl.close();
        resolve();
      });
    });

    return {
      strategy: 'Manual CAPTCHA resolution',
      success: true,
      notes: 'CAPTCHA resolved manually'
    };
  }

  private async getVisibleElements(): Promise<string[]> {
    try {
      return await this.page.evaluate(() => {
        const elements = document.querySelectorAll('*');
        const visible: string[] = [];
        
        for (let i = 0; i < Math.min(elements.length, 50); i++) {
          const el = elements[i] as HTMLElement;
          if (el.offsetParent !== null && el.tagName) {
            const selector = `${el.tagName.toLowerCase()}${el.className ? '.' + el.className.split(' ').join('.') : ''}${el.id ? '#' + el.id : ''}`;
            visible.push(selector);
          }
        }
        
        return visible;
      });
    } catch (e) {
      return [];
    }
  }

  private extractSelectorsFromText(text: string): string[] {
    // Extract CSS selectors from LLM response
    const selectorPatterns = [
      /[#.]\w+[\w\-]*/g,                    // #id, .class
      /\w+\[[^\]]+\]/g,                     // element[attribute]
      /\w+:\w+\([^)]*\)/g,                  // element:pseudo()
      /[a-zA-Z]+[\w\-]*(?:\s*[>,]\s*\w+)*/g // element combinations
    ];

    const selectors: string[] = [];
    
    for (const pattern of selectorPatterns) {
      const matches = text.match(pattern) || [];
      selectors.push(...matches);
    }

    return [...new Set(selectors)].slice(0, 5); // Remove duplicates, limit to 5
  }

  private fallbackErrorAnalysis(errorMessage: string, context: string): ErrorAnalysis {
    if (errorMessage.includes('timeout')) {
      return {
        errorType: 'timeout',
        severity: 'medium',
        suggestedFixes: ['increase timeout', 'wait for load', 'retry navigation'],
        alternativeLocators: [],
        shouldRetry: true,
        retryDelay: 5000
      };
    }

    if (errorMessage.includes('locator') || errorMessage.includes('selector')) {
      return {
        errorType: 'locator',
        severity: 'high',
        suggestedFixes: ['try alternative locators', 'update selectors', 'wait for element'],
        alternativeLocators: this.getContextBasedLocators(context),
        shouldRetry: true,
        retryDelay: 2000
      };
    }

    return {
      errorType: 'unknown',
      severity: 'medium',
      suggestedFixes: ['retry operation', 'wait and retry'],
      alternativeLocators: [],
      shouldRetry: true,
      retryDelay: 3000
    };
  }

  private getContextBasedLocators(context: string): string[] {
    if (context.includes('login')) {
      return ['#usernameField', '[name="email"]', '[type="email"]', '#emailField'];
    }
    
    if (context.includes('job')) {
      return ['.jobTuple', '.job-card', '.job-listing', '.title'];
    }
    
    if (context.includes('apply')) {
      return ['button:has-text("Apply")', '.apply-btn', 'a:has-text("Apply")'];
    }

    return [];
  }

  private logError(error: string): void {
    const count = this.errorHistory.get(error) || 0;
    this.errorHistory.set(error, count + 1);
  }
}
