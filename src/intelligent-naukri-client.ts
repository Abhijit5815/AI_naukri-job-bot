import * as fs from 'fs';
import * as path from 'path';
import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { LLMJobAnalyzer, JobAnalysis } from './llm-analyzer';
import { ErrorAnalysisEngine, ErrorAnalysis, FixAttempt } from './error-analyzer';

// GLOBAL TIMEOUT CONFIGURATION - Adjust this single value to change all timeouts
const GLOBAL_TIMEOUT_MS = 90000; // 90 seconds - change this to adjust all timeouts
const ELEMENT_TIMEOUT_MS = Math.floor(GLOBAL_TIMEOUT_MS / 3); // 30 seconds for element waits
const WAIT_BETWEEN_ACTIONS_MS = 3000; // 3 seconds between actions

interface Credentials {
  naukri: {
    email: string;
    password: string;
  };
  userProfile: {
    name: string;
    experience: string;
    skills: string[];
    currentRole: string;
    careerGoals: string;
  };
  jobPreferences: {
    keywords: string[];
    location: string;
    maxApplications: number;
    minExperience:number;
    minimumConfidenceScore: number;
    maxRetryAttempts: number;
    excludeCompanies: string[];  // Companies to avoid
    excludeKeywords: string[];   // Job keywords to avoid
  };
}

interface ApplicationResult {
  jobTitle: string;
  company: string;
  companyRating?: string;
  location?: string;
  experience?: string;
  salary?: string;
  skills?: string[];
  postedDate?: string;
  analysis: JobAnalysis;
  applied: boolean;
  reason: string;
  errors?: string[];
  fixes?: FixAttempt[];
  excluded?: boolean;
  exclusionReason?: string;
}

export class SelfHealingIntelligentNaukriBot {
  private credentials: Credentials;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private llmAnalyzer: LLMJobAnalyzer;
  private errorAnalyzer: ErrorAnalysisEngine | null = null;
  private appliedJobs: Set<string> = new Set();
  private applicationResults: ApplicationResult[] = [];
  private excludedJobs: ApplicationResult[] = [];
  private errorStats = {
    totalErrors: 0,
    fixedErrors: 0,
    errorTypes: new Map<string, number>()
  };

  constructor() {
    this.credentials = this.loadCredentials();
    
    console.log(`⏰ Global timeout configuration: ${GLOBAL_TIMEOUT_MS / 1000} seconds`);
    console.log(`🎯 Element timeout: ${ELEMENT_TIMEOUT_MS / 1000} seconds`);
    console.log(`⏱️ Action delay: ${WAIT_BETWEEN_ACTIONS_MS / 1000} seconds\n`);
    
    const userProfile = `
Name: ${this.credentials.userProfile.name}
Experience: ${this.credentials.userProfile.experience}
Current Role: ${this.credentials.userProfile.currentRole}
Skills: ${this.credentials.userProfile.skills.join(', ')}
Career Goals: ${this.credentials.userProfile.careerGoals}
`;

    this.llmAnalyzer = new LLMJobAnalyzer(userProfile);
  }

  private loadCredentials(): Credentials {
    const credentialsPath = path.join(__dirname, 'config', 'credentials.json');
    
    try {
      const credentialsData = fs.readFileSync(credentialsPath, 'utf8');
      const credentials = JSON.parse(credentialsData) as Credentials;
      
      // Set defaults for new fields
      if (!credentials.jobPreferences.maxRetryAttempts) {
        credentials.jobPreferences.maxRetryAttempts = 3;
      }
      if (!credentials.jobPreferences.excludeCompanies) {
        credentials.jobPreferences.excludeCompanies = [];
      }
      if (!credentials.jobPreferences.excludeKeywords) {
        credentials.jobPreferences.excludeKeywords = [];
      }
      
      console.log('✅ Credentials and profile loaded successfully');
      if (credentials.jobPreferences.excludeCompanies.length > 0) {
        console.log(`🚫 Excluded companies: ${credentials.jobPreferences.excludeCompanies.join(', ')}`);
      }
      if (credentials.jobPreferences.excludeKeywords.length > 0) {
        console.log(`🚫 Excluded keywords: ${credentials.jobPreferences.excludeKeywords.join(', ')}`);
      }
      
      return credentials;
    } catch (error) {
      console.error('❌ Error loading credentials file');
      process.exit(1);
    }
  }

  private async ensureBrowserReady(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({ 
        headless: false,
       // slowMo: 1500,
        devtools: false,
        args: ['--disable-web-security', '--disable-features=VizDisplayCompositor']
      });
    }

    if (!this.context) {
      this.context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });
      
      this.context.setDefaultTimeout(GLOBAL_TIMEOUT_MS);
      this.context.setDefaultNavigationTimeout(GLOBAL_TIMEOUT_MS);
    }

    if (!this.page) {
      this.page = await this.context.newPage();
      this.errorAnalyzer = new ErrorAnalysisEngine(this.page);
    }
  }

  private async executeWithErrorRecovery<T>(
    operation: () => Promise<T>,
    context: string,
    maxRetries?: number
  ): Promise<T | null> {
    const retries = maxRetries || this.credentials.jobPreferences.maxRetryAttempts;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`🔄 Executing: ${context} (Attempt ${attempt}/${retries})`);
        const result = await operation();
        return result;
      } catch (error) {
        const err = error as Error;
        console.log(`❌ Error in ${context}: ${err.message}`);
        this.errorStats.totalErrors++;
        
        if (!this.errorAnalyzer) {
          throw error;
        }

        const analysis: ErrorAnalysis = await this.errorAnalyzer.analyzeError(
          err,
          context,
          this.page?.url() || ''
        );

        console.log(`🤖 Error Analysis:`);
        console.log(`   Type: ${analysis.errorType}`);
        console.log(`   Severity: ${analysis.severity}`);
        console.log(`   Should Retry: ${analysis.shouldRetry}`);

        const errorType = analysis.errorType;
        this.errorStats.errorTypes.set(errorType, (this.errorStats.errorTypes.get(errorType) || 0) + 1);

        if (attempt < retries && analysis.shouldRetry) {
          const fixResult: FixAttempt = await this.errorAnalyzer.attemptFix(
            err,
            analysis,
            context
          );

          if (fixResult.success) {
            console.log(`✅ Auto-fix successful: ${fixResult.strategy}`);
            this.errorStats.fixedErrors++;
            await new Promise(resolve => setTimeout(resolve, analysis.retryDelay));
            continue;
          } else {
            console.log(`❌ Auto-fix failed: ${fixResult.notes}`);
          }

          await new Promise(resolve => setTimeout(resolve, analysis.retryDelay));
        } else {
          if (analysis.severity === 'high') {
            throw error;
          } else {
            console.log(`⚠️ Continuing despite error: ${err.message}`);
            return null;
          }
        }
      }
    }

    throw new Error(`Max retries (${retries}) exceeded for operation: ${context}`);
  }

  // Enhanced exclusion check using LLM
  private async isJobExcluded(jobTitle: string, company: string, jobDescription: string): Promise<{excluded: boolean, reason: string}> {
    try {
      // Basic keyword exclusion check first
      const jobText = `${jobTitle} ${company} ${jobDescription}`.toLowerCase();
      
      // Check excluded keywords in job title/description
      for (const keyword of this.credentials.jobPreferences.excludeKeywords) {
        if (jobText.includes(keyword.toLowerCase())) {
          return {
            excluded: true,
            reason: `Contains excluded keyword: "${keyword}"`
          };
        }
      }

      // Use LLM for intelligent company exclusion
      if (this.credentials.jobPreferences.excludeCompanies.length > 0) {
        const exclusionPrompt = `
Analyze if this company should be excluded from job applications.

Job Details:
- Company: ${company}
- Job Title: ${jobTitle}

Excluded Companies List: ${this.credentials.jobPreferences.excludeCompanies.join(', ')}

Instructions:
1. Check if the company name matches any company in the excluded list
2. Consider variations, subsidiaries, and different naming conventions
3. For example, if "iris" is in excluded list, it should match "Iris Software", "Iris Technologies", "Iris Software Pvt Ltd", etc.
4. Be intelligent about matching - consider partial matches and common business suffixes like Ltd, Pvt Ltd, Inc, Corp, Technologies, Software, Solutions, etc.
5. If "tcs" is excluded, match "Tata Consultancy Services", "TCS", etc.
6. If "wipro" is excluded, match "Wipro Limited", "Wipro Technologies", etc.

Respond with ONLY:
- "EXCLUDE: [reason]" if the company should be excluded
- "INCLUDE: Company not in exclusion list" if the company should be included

Response:`;

        const llmResponse = await this.llmAnalyzer.analyzeExclusion(exclusionPrompt);
        
        if (llmResponse.toUpperCase().startsWith('EXCLUDE:')) {
          const reason = llmResponse.substring(8).trim();
          return {
            excluded: true,
            reason: `LLM exclusion: ${reason}`
          };
        }
      }

      return {
        excluded: false,
        reason: 'Not excluded'
      };

    } catch (error) {
      console.log('⚠️ Error in LLM exclusion check, using fallback method');
      
      // Fallback to basic string matching
      const companyLower = company.toLowerCase();
      const jobTextLower = `${jobTitle} ${jobDescription}`.toLowerCase();
      
      // Check excluded companies with basic matching
      for (const excludedCompany of this.credentials.jobPreferences.excludeCompanies) {
        if (companyLower.includes(excludedCompany.toLowerCase())) {
          return {
            excluded: true,
            reason: `Company matches excluded pattern: "${excludedCompany}"`
          };
        }
      }
      
      // Check excluded keywords
      for (const keyword of this.credentials.jobPreferences.excludeKeywords) {
        if (jobTextLower.includes(keyword.toLowerCase())) {
          return {
            excluded: true,
            reason: `Contains excluded keyword: "${keyword}"`
          };
        }
      }

      return {
        excluded: false,
        reason: 'Not excluded (fallback check)'
      };
    }
  }

  private async loginToNaukri(): Promise<void> {
    await this.executeWithErrorRecovery(async () => {
      if (!this.page) throw new Error('Browser not initialized');

      console.log('🔐 Logging into Naukri...');
      
      await this.page.goto('https://www.naukri.com/nlogin/login', { timeout: GLOBAL_TIMEOUT_MS });
      //await this.page.waitForLoadState('domcontentloaded', { timeout: GLOBAL_TIMEOUT_MS });

      const emailSelectors = ['#usernameField', '[name="email"]', '[type="email"]'];
      const passwordSelectors = ['#passwordField', '[name="password"]', '[type="password"]'];

      let emailFilled = false;
      for (const selector of emailSelectors) {
        try {
          const emailField = this.page.locator(selector).first();
          if (await emailField.isVisible({ timeout: ELEMENT_TIMEOUT_MS })) {
            await emailField.fill(this.credentials.naukri.email);
            emailFilled = true;
            break;
          }
        } catch (e) { continue; }
      }

      if (!emailFilled) throw new Error('Could not find email field');

      let passwordFilled = false;
      for (const selector of passwordSelectors) {
        try {
          const passwordField = this.page.locator(selector).first();
          if (await passwordField.isVisible({ timeout: ELEMENT_TIMEOUT_MS })) {
            await passwordField.fill(this.credentials.naukri.password);
            passwordFilled = true;
            break;
          }
        } catch (e) { continue; }
      }

      if (!passwordFilled) throw new Error('Could not find password field');

      await this.page.waitForTimeout(WAIT_BETWEEN_ACTIONS_MS);

      const submitSelectors = ['button[type="submit"]', '.login-btn', '#loginButton', 'button:has-text("Login")'];
      
      let submitClicked = false;
      for (const selector of submitSelectors) {
        try {
          const submitBtn = this.page.locator(selector).first();
          if (await submitBtn.isVisible({ timeout: ELEMENT_TIMEOUT_MS })) {
            await submitBtn.click();
            submitClicked = true;
            break;
          }
        } catch (e) { continue; }
      }

      if (!submitClicked) throw new Error('Could not find submit button');

     // try {
     //  await Promise.race([
     //     this.page.waitForSelector('.nI-gNb-drawer__icon', { timeout: GLOBAL_TIMEOUT_MS }),
     //     this.page.waitForSelector('[data-automation="mNaukriLogo"]', { timeout: GLOBAL_TIMEOUT_MS }),
     //     this.page.waitForURL('**/homepage', { timeout: GLOBAL_TIMEOUT_MS })
     //   ]);
     //   console.log('✅ Successfully logged into Naukri');
     // } catch (waitError) {
     //   const currentUrl = this.page.url();
     //   if (!currentUrl.includes('login')) {
     //     console.log('✅ Login appears successful (detected by URL)');
     //   } else {
     //     throw new Error('Login verification failed');
     //   }
     // }  
     // Replace the existing login verification part with this:
try {
  // Fast login verification using "View profile" link
  await this.page.waitForSelector('a:has-text("View profile")', { 
    timeout: GLOBAL_TIMEOUT_MS 
  });
  console.log('✅ Successfully logged into Naukri');
  
  // Minimal wait since we know we're logged in
  await this.page.waitForTimeout(1000);
  
} catch (error) {
  // Fallback check
  try {
    await this.page.waitForSelector('a[href*="profile"]:has-text("View profile")', { timeout: 5000 });
    console.log('✅ Successfully logged into Naukri - Profile link verified');
    await this.page.waitForTimeout(1000);
  } catch (fallbackError) {
    throw new Error(`Login failed - Could not verify profile link:`);
  }
}

    }, 'login');
  }

  private async searchJobs(): Promise<void> {
    await this.executeWithErrorRecovery(async () => {
      if (!this.page) throw new Error('Browser not initialized');

      console.log('🔍 Searching for jobs...');
      
      // Navigate to search page
      await this.page.goto('https://www.naukri.com/', { timeout: GLOBAL_TIMEOUT_MS });
      await this.page.waitForLoadState('domcontentloaded', { timeout: GLOBAL_TIMEOUT_MS });

      // Handle any popups that might appear
      await this.handlePopups();

      const keywordsString = this.credentials.jobPreferences.keywords.join(' ');
      
      // Enhanced search bar selectors based on the HTML structure
      const keywordSelectors = [
        '.suggestor-input[placeholder*="keyword"]',
        '.suggestor-input[placeholder*="designation"]',
        '.nI-gNb-sb__keywords input',
        'input[placeholder*="Enter keyword"]',
        '.nI-gNb-sugg input'
      ];

      const locationSelectors = [
        '.suggestor-input[placeholder*="location"]',
        '.nI-gNb-sb__locations input',
        'input[placeholder*="Enter location"]'
      ];

      const searchButtonSelectors = [
        '.nI-gNb-sb__icon-wrapper',
        '.ni-gnb-icn-search',
        'button:has(.ni-gnb-icn-search)',
        '.nI-gNb-sb__main button'
      ];

      // Fill keyword field
      let keywordFilled = false;
      await this.page.locator('div[class*="search-bar"] span[class*="placeholder"]').click();
      for (const selector of keywordSelectors) {
        try {
          const field = this.page.locator(selector).first();
          if (await field.isVisible({ timeout: ELEMENT_TIMEOUT_MS })) {
            await field.clear();
            await this.page.waitForTimeout(1000);
            await field.fill(keywordsString);
            await this.page.waitForTimeout(2000);
            
            // Dismiss any dropdown
            //await this.page.keyboard.press('Escape');
            //await this.page.waitForTimeout(1000);
            
            keywordFilled = true;
            console.log(`✅ Filled keyword field: ${keywordsString}`);
            break;
          }
        } catch (e) { continue; }
      }

      if (!keywordFilled) throw new Error('Could not find keyword input field');
     //Fill Experience
     // SET EXPERIENCE DROPDOWN - SIMPLE APPROACH WITH CREDENTIALS
try {
  console.log('🎯 Setting experience dropdown...');
  
  // Click on experience dropdown to open it
  const experienceDropdown = this.page.locator('#experienceDD').first();
  await experienceDropdown.click();
  console.log('✅ Clicked experience dropdown');
  
  // Wait for dropdown options to appear
  await this.page.waitForTimeout(1000);
  
  // Get experience from credentials and click on that option
  const experienceYears = `${this.credentials.jobPreferences.minExperience} years`; // This will be "9 years"
  await this.page.locator(`li[title="${experienceYears}"]`).click();
  console.log(`✅ Selected experience: ${experienceYears}`);
  
  await this.page.waitForTimeout(1000);
  
} catch (experienceError) {
  console.log(`⚠️ Could not set experience dropdown: ${experienceError}`);
}
     
      // Fill location field
// CORRECT - use all locations:
    const location = this.credentials.jobPreferences.location; // "Noida, Delhi, Gurgaon, Bengaluru"

      
      let locationFilled = false;
      for (const selector of locationSelectors) {
        try {
          const field = this.page.locator(selector).first();
          if (await field.isVisible({ timeout: ELEMENT_TIMEOUT_MS })) {
            await field.clear();
            await this.page.waitForTimeout(1000);
            await field.fill(location);
            await this.page.waitForTimeout(2000);
            
            // Handle dropdown if it appears
            //await this.page.keyboard.press('Escape');
            //await this.page.waitForTimeout(1000);
            
            locationFilled = true;
            console.log(`✅ Filled location field: ${location}`);
            break;
          }
        } catch (e) { continue; }
      }

      if (!locationFilled) {
        console.log('⚠️ Could not find location field, continuing without it');
      }

      await this.page.waitForTimeout(WAIT_BETWEEN_ACTIONS_MS);

      // Click search button
      let searchClicked = false;
      for (const selector of searchButtonSelectors) {
        try {
          const button = this.page.locator(selector).first();
          if (await button.isVisible({ timeout: ELEMENT_TIMEOUT_MS })) {
            await button.scrollIntoViewIfNeeded();
            await this.page.waitForTimeout(1000);
            await button.click();
            searchClicked = true;
            console.log(`✅ Clicked search button: ${selector}`);
            break;
          }
        } catch (e) { 
          console.log(`⚠️ Search button selector failed: ${selector}`);
          continue; 
        }
      }

      if (!searchClicked) {
        // Fallback: try Enter key or direct URL navigation
        try {
          await this.page.keyboard.press('Enter');
          await this.page.waitForTimeout(3000);
          searchClicked = true;
          console.log('✅ Triggered search with Enter key');
        } catch (enterError) {
          const keywords = encodeURIComponent(keywordsString);
          const locationParam = encodeURIComponent(location);
          const searchUrl = `https://www.naukri.com/${keywords.replace(/%20/g, '-')}-jobs-in-${locationParam.replace(/%20/g, '-')}`;
          
          await this.page.goto(searchUrl, { timeout: GLOBAL_TIMEOUT_MS });
          searchClicked = true;
          console.log('✅ Navigated directly to search results');
        }
      }

      if (!searchClicked) {
        throw new Error('Could not trigger job search');
      }

      // Wait for search results with updated selectors
      await this.page.waitForTimeout(5000);
      
      /*try {
        await Promise.race([
          this.page.waitForSelector('.srp-jobtuple-wrapper', { timeout: GLOBAL_TIMEOUT_MS }),
          this.page.waitForSelector('.styles_job-listing-container__OCfZC', { timeout: GLOBAL_TIMEOUT_MS }),
          this.page.waitForSelector('.cust-job-tuple', { timeout: GLOBAL_TIMEOUT_MS })
        ]); */
        try {
  await Promise.race([
    // Most stable primary selector
    this.page.waitForSelector('.srp-jobtuple-wrapper', { timeout: GLOBAL_TIMEOUT_MS }),
    
    // Alternative stable selector
    this.page.waitForSelector('.cust-job-tuple', { timeout: GLOBAL_TIMEOUT_MS }),
    
    // Additional stable options
    this.page.waitForSelector('.sjw__tuple', { timeout: GLOBAL_TIMEOUT_MS }),
    
    // Dynamic selector using partial class matching (avoids hash issues)
    this.page.waitForSelector('[class*="job-listing-container"]', { timeout: GLOBAL_TIMEOUT_MS }),
    
    // Semantic selectors as fallback
    this.page.waitForSelector('article[class*="tuple"]', { timeout: GLOBAL_TIMEOUT_MS }),
    this.page.waitForSelector('div[class*="job-tuple"]', { timeout: GLOBAL_TIMEOUT_MS }),
    
    // Data attribute based selector (if available)
    this.page.waitForSelector('[data-job-id]', { timeout: GLOBAL_TIMEOUT_MS })
  ]);
         console.log('✅ Search results loaded');

  } 
        catch (resultsError) {
        const currentUrl = this.page.url();
        if (currentUrl.includes('jobs')) {
          console.log('✅ Search completed (detected by URL)');
        } else {
          throw new Error('Search results did not load properly');
        }
      }

      console.log('✅ Job search completed successfully');
    }, 'job_search');
  }

  private async handlePopups(): Promise<void> {
    if (!this.page) return;
    
    try {
      // Handle various popups and overlays
      const popupSelectors = [
        '.nI-gNb-backdrop',
        '.modal-backdrop', 
        '[data-testid="backdrop"]',
        '.popup-overlay'
      ];
      
      for (const selector of popupSelectors) {
        try {
          const popup = await this.page.$(selector);
          if (popup) {
            await popup.click();
            await this.page.waitForTimeout(1000);
          }
        } catch (e) { continue; }
      }

      // Close any notification banners
      const closeButtons = await this.page.$$('button[aria-label="Close"], .close-btn, .dismiss');
      for (const button of closeButtons) {
        try {
          await button.click();
          await this.page.waitForTimeout(500);
        } catch (e) { continue; }
      }
    } catch (error) {
      console.log('⚠️ Error handling popups:', error);
    }
  }

  private async analyzeAndApplyToJobs(): Promise<void> {
    await this.executeWithErrorRecovery(async () => {
      if (!this.page) throw new Error('Browser not initialized');

      let applicationsCount = 0;
      let currentPage = 1;
      const maxApplications = this.credentials.jobPreferences.maxApplications;
      const minConfidence = this.credentials.jobPreferences.minimumConfidenceScore;

      console.log(`🤖 Starting AI-powered job analysis and applications...`);

      while (applicationsCount < maxApplications) {
        console.log(`\n📄 Analyzing jobs on page ${currentPage}...`);
        
        // Updated job card selectors based on HTML structure
        const jobCardSelectors = [
          '.srp-jobtuple-wrapper', 
          '.cust-job-tuple',
          '.styles_jlc__main__VdwtF .srp-jobtuple-wrapper'
        ];
        
        let jobCards: any[] = [];

        for (const selector of jobCardSelectors) {
          try {
            await this.page.waitForSelector(selector, { timeout: ELEMENT_TIMEOUT_MS });
            jobCards = await this.page.locator(selector).all();
            if (jobCards.length > 0) {
              console.log(`✅ Found ${jobCards.length} jobs using selector: ${selector}`);
              break;
            }
          } catch (e) { continue; }
        }
        
        if (jobCards.length === 0) {
          console.log('No more jobs found');
          break;
        }

        for (const jobCard of jobCards) {
          if (applicationsCount >= maxApplications) break;

          const jobResult = await this.processJobWithErrorRecovery(jobCard, applicationsCount, maxApplications, minConfidence);
          
          if (jobResult) {
            if (jobResult.excluded) {
              this.excludedJobs.push(jobResult);
            } else {
              this.applicationResults.push(jobResult);
              if (jobResult.applied) {
                applicationsCount++;
              }
            }
          }
        }

        const nextResult = await this.navigateToNextPage(currentPage, applicationsCount, maxApplications);
        if (!nextResult.success) break;
        
        currentPage++;
      }
    }, 'job_analysis_and_application');
  }

  private async processJobWithErrorRecovery(
    jobCard: any,
    applicationsCount: number,
    maxApplications: number,
    minConfidence: number
  ): Promise<ApplicationResult | null> {
    const timestamp = Date.now();
    const contextId = `process_job_${timestamp}`;
    
    return await this.executeWithErrorRecovery(async () => {
      if (!this.page) throw new Error('Browser not initialized');

      // Enhanced selectors based on HTML structure
      const titleSelectors = [
        '.title',
        'h2 a[title]',
        'a.title',
        '.job-title'
      ];
      
      const companySelectors = [
        '.comp-name',
        'a[title][href*="jobs-careers"]',
        '.company-name'
      ];

      const ratingSelectors = [
        '.rating .main-2',
        '.ni-job-tuple-icon-ot_star + span'
      ];

      const locationSelectors = [
        '.locWdth',
        '.ni-job-tuple-icon-srp-location + span'
      ];

      const experienceSelectors = [
        '.expwdth', 
        '.ni-job-tuple-icon-srp-experience + span'
      ];

      const salarySelectors = [
        '.sal span',
        '.ni-job-tuple-icon-srp-rupee + span'
      ];

      const skillSelectors = [
        '.tags-gt .tag-li',
        '.dot-gt.tag-li'
      ];

      const descriptionSelectors = [
        '.job-desc',
        '.ni-job-tuple-icon-srp-description'
      ];

      const postedDateSelectors = [
        '.job-post-day'
      ];
      
      let jobTitle = '';
      let company = '';
      let companyRating = '';
      let location = '';
      let experience = '';
      let salary = 'Not specified';
      let skills: string[] = [];
      let description = '';
      let postedDate = '';

      // Extract job title
      for (const selector of titleSelectors) {
        try {
          const element = await jobCard.locator(selector).first();
          if (await element.isVisible({ timeout: 2000 })) {
            const titleText = await element.getAttribute('title') || await element.textContent();
            if (titleText && titleText.trim()) {
              jobTitle = titleText.trim();
              console.log(`✅ Found job title: ${jobTitle}`);
              break;
            }
          }
        } catch (e) { continue; }
      }

      // Extract company name
      for (const selector of companySelectors) {
        try {
          const element = await jobCard.locator(selector).first();
          if (await element.isVisible({ timeout: 2000 })) {
            const companyText = await element.getAttribute('title') || await element.textContent();
            if (companyText && companyText.trim()) {
              company = companyText.trim();
              console.log(`✅ Found company: ${company}`);
              break;
            }
          }
        } catch (e) { continue; }
      }

      // Extract additional job details
      for (const selector of ratingSelectors) {
        try {
          const element = await jobCard.locator(selector).first();
          if (await element.isVisible({ timeout: 1000 })) {
            companyRating = await element.textContent() || '';
            break;
          }
        } catch (e) { continue; }
      }

      for (const selector of locationSelectors) {
        try {
          const element = await jobCard.locator(selector).first();
          if (await element.isVisible({ timeout: 1000 })) {
            location = await element.getAttribute('title') || await element.textContent() || '';
            break;
          }
        } catch (e) { continue; }
      }

      for (const selector of experienceSelectors) {
        try {
          const element = await jobCard.locator(selector).first();
          if (await element.isVisible({ timeout: 1000 })) {
            experience = await element.getAttribute('title') || await element.textContent() || '';
            break;
          }
        } catch (e) { continue; }
      }

      for (const selector of salarySelectors) {
        try {
          const element = await jobCard.locator(selector).first();
          if (await element.isVisible({ timeout: 1000 })) {
            salary = await element.getAttribute('title') || await element.textContent() || '';
            if (salary.trim()) break;
          }
        } catch (e) { continue; }
      }

      // Extract skills
      for (const selector of skillSelectors) {
        try {
          const elements = await jobCard.locator(selector).all();
          for (const element of elements) {
            const skillText = await element.textContent();
            if (skillText && skillText.trim()) {
              skills.push(skillText.trim());
            }
          }
          if (skills.length > 0) break;
        } catch (e) { continue; }
      }

      // Extract job description
      for (const selector of descriptionSelectors) {
        try {
          const element = await jobCard.locator(selector).first();
          if (await element.isVisible({ timeout: 1000 })) {
            description = await element.textContent() || '';
            if (description.trim()) break;
          }
        } catch (e) { continue; }
      }

      // Extract posted date
      for (const selector of postedDateSelectors) {
        try {
          const element = await jobCard.locator(selector).first();
          if (await element.isVisible({ timeout: 1000 })) {
            postedDate = await element.textContent() || '';
            break;
          }
        } catch (e) { continue; }
      }

      if (!jobTitle || !company) {
        console.log(`⏭️ Skipping job - missing basic info. Title: "${jobTitle}", Company: "${company}"`);
        return null;
      }

      const jobId = `${jobTitle}-${company}`;
      
      if (this.appliedJobs.has(jobId)) {
        console.log(`⏭️ Already applied to: ${jobTitle} at ${company}`);
        return null;
      }

      console.log(`\n🔍 Analyzing: ${jobTitle} at ${company}`);
      if (location) console.log(`📍 Location: ${location}`);
      if (experience) console.log(`💼 Experience: ${experience}`);
      if (salary !== 'Not specified') console.log(`💰 Salary: ${salary}`);
      if (skills.length > 0) console.log(`🛠️ Skills: ${skills.join(', ')}`);
      if (companyRating) console.log(`⭐ Rating: ${companyRating}`);

      // Check for exclusion before proceeding
      console.log(`🔍 Checking exclusion criteria...`);
      const exclusionCheck = await this.isJobExcluded(jobTitle, company, description);
      
      if (exclusionCheck.excluded) {
        console.log(`🚫 JOB EXCLUDED: ${exclusionCheck.reason}`);
        
        const excludedResult: ApplicationResult = {
          jobTitle,
          company,
          companyRating,
          location,
          experience,
          salary,
          skills,
          postedDate,
          analysis: {
            shouldApply: false,
            confidenceScore: 0,
            reasoning: 'Job excluded due to user preferences',
            matchedSkills: [],
            concerns: [exclusionCheck.reason]
          },
          applied: false,
          reason: exclusionCheck.reason,
          excluded: true,
          exclusionReason: exclusionCheck.reason
        };
        
        return excludedResult;
      }
      
      console.log(`✅ Job passed exclusion criteria`);

      // Click on job to get more details and handle new tab opening
try {
  await jobCard.scrollIntoViewIfNeeded();
  await this.page.waitForTimeout(1000);
  
  // Get current number of pages/tabs before clicking
  const initialPageCount = this.context!.pages().length;
  
  // Try to click on job title link first
  const titleLink = await jobCard.locator('.title, h2 a').first();
  if (await titleLink.isVisible({ timeout: 3000 })) {
    await titleLink.click();
  } else {
    await jobCard.click();
  }
  
  await this.page.waitForTimeout(WAIT_BETWEEN_ACTIONS_MS);
  
  // Check if a new tab was opened
  const currentPageCount = this.context!.pages().length;
  
  if (currentPageCount > initialPageCount) {
    // New tab was opened, switch to it
    const pages = this.context!.pages();
    const newPage = pages[pages.length - 1]; // Get the newest page/tab
    
    console.log('🔄 New tab detected, switching to job details tab');
    this.page = newPage; // Switch context to the new tab
    
    // Wait for the new page to load properly
    await this.page.waitForTimeout(3000);
    console.log(`✅ Switched to job details tab successfully`);
  } else {
    console.log(`✅ Clicked on job successfully (same tab)`);
  }
  
} catch (clickError) {
  console.log(`⚠️ Error clicking job: ${clickError}`);
  try {
    // Get initial page count for fallback click too
    const initialPageCount = this.context!.pages().length;
    
    await jobCard.click({ force: true });
    await this.page.waitForTimeout(WAIT_BETWEEN_ACTIONS_MS);
    
    // Check for new tab after force click
    const currentPageCount = this.context!.pages().length;
    if (currentPageCount > initialPageCount) {
      const pages = this.context!.pages();
      this.page = pages[pages.length - 1];
      console.log('🔄 New tab opened after force click, switched to it');
      await this.page.waitForTimeout(3000);
    }
    
  } catch (forceClickError) {
    console.log(`❌ Force click also failed, using existing description`);
  }
}

      // Try to get detailed description from job details page
      const detailedDescriptionSelectors = [
        '.jd-container',
        '.job-description', 
        '.dang-inner-html',
        '.job-detail',
        '[data-automation="jobDescription"]'
      ];

      let detailedDescription = description;
      for (const selector of detailedDescriptionSelectors) {
        try {
          const element = this.page.locator(selector).first();
          if (await element.isVisible({ timeout: 5000 })) {
            const desc = await element.textContent();
            if (desc && desc.trim().length > detailedDescription.length) {
              detailedDescription = desc.trim();
              console.log(`✅ Found detailed description (${desc.length} chars)`);
              
              // Re-check exclusion with detailed description
              const detailedExclusionCheck = await this.isJobExcluded(jobTitle, company, detailedDescription);
              if (detailedExclusionCheck.excluded) {
                console.log(`🚫 JOB EXCLUDED after detailed analysis: ${detailedExclusionCheck.reason}`);
                
                const excludedResult: ApplicationResult = {
                  jobTitle,
                  company,
                  companyRating,
                  location,
                  experience,
                  salary,
                  skills,
                  postedDate,
                  analysis: {
                    shouldApply: false,
                    confidenceScore: 0,
                    reasoning: 'Job excluded after detailed analysis',
                    matchedSkills: [],
                    concerns: [detailedExclusionCheck.reason]
                  },
                  applied: false,
                  reason: detailedExclusionCheck.reason,
                  excluded: true,
                  exclusionReason: detailedExclusionCheck.reason
                };
                
                // Navigate back
                try {
                  await this.page.goBack();
                  await this.page.waitForTimeout(WAIT_BETWEEN_ACTIONS_MS);
                } catch (backError) {
                  console.log(`⚠️ Error going back: ${backError}`);
                }
                
                return excludedResult;
              }
              break;
            }
          }
        } catch (e) { continue; }
      }

      // Combine all job information for analysis
      const fullJobDescription = `
Title: ${jobTitle}
Company: ${company}
Location: ${location}
Experience: ${experience}
Salary: ${salary}
Skills: ${skills.join(', ')}
Rating: ${companyRating}
Posted: ${postedDate}
Description: ${detailedDescription}
`;

      console.log(`🤖 Sending job to AI for analysis...`);
      let analysis: JobAnalysis;
      
      try {
        analysis = await this.llmAnalyzer.analyzeJob(jobTitle, company, fullJobDescription, salary);
        console.log(`🤖 AI Analysis Complete:`);
        console.log(`   Should Apply: ${analysis.shouldApply ? '✅ YES' : '❌ NO'}`);
        console.log(`   Confidence: ${analysis.confidenceScore}%`);
        console.log(`   Reasoning: ${analysis.reasoning}`);
        console.log(`   Matched Skills: ${analysis.matchedSkills.join(', ')}`);
        if (analysis.concerns.length > 0) {
          console.log(`   Concerns: ${analysis.concerns.join(', ')}`);
        }
      } catch (analysisError) {
        console.log(`⚠️ AI analysis failed, using fallback logic`);
        analysis = {
          shouldApply: this.fallbackJobAnalysis(jobTitle, fullJobDescription),
          confidenceScore: 50,
          reasoning: 'Fallback analysis due to AI failure',
          matchedSkills: skills.filter(skill => 
            this.credentials.userProfile.skills.some(userSkill => 
              userSkill.toLowerCase().includes(skill.toLowerCase())
            )
          ),
          concerns: []
        };
      }

      let applied = false;
      let reason = '';
      const errors: string[] = [];
      const fixes: FixAttempt[] = [];

      if (analysis.shouldApply && analysis.confidenceScore >= minConfidence) {
        console.log(`🎯 AI recommends applying! Attempting application...`);
        
        const applyResult = await this.executeWithErrorRecovery(async () => {
          if (!this.page) throw new Error('Page not available');

          // Enhanced apply button selectors
       const applySelectors = [
      'div[class*="apply-button-container"] #apply-button',  // Your confirmed working selector - first priority
      '#apply-button',
      'button[class*="apply-button"]',
      'button:has-text("Apply")',
      'a:has-text("Apply")',
      '.apply-btn'
      ];

          let applyClicked = false;
          
          for (const selector of applySelectors) {
            try {
              const applyButton = this.page.locator(selector).first();
              if (await applyButton.isVisible({ timeout: ELEMENT_TIMEOUT_MS })) {
                console.log(`✅ Found apply button: ${selector}`);
                await applyButton.scrollIntoViewIfNeeded();
                await this.page.waitForTimeout(1000);
                await applyButton.click();
                applyClicked = true;
                console.log(`✅ Clicked apply button successfully`);
                await this.page.waitForTimeout(ELEMENT_TIMEOUT_MS);
                break;
              }
            } catch (e) { 
              console.log(`⚠️ Apply selector failed: ${selector}`);
              continue; 
            }
          }

          if (!applyClicked) {
            throw new Error('No apply button found');
          }

          // Handle confirmation if needed
          const confirmSelectors = [
            'button:has-text("Confirm")',
            'button:has-text("Submit")',
            'button:has-text("Apply Now")',
            'button:has-text("Send Application")',
            '[data-automation="confirmApply"]',
            '.confirm-apply'
          ];

          for (const confirmSelector of confirmSelectors) {
            try {
              const confirmButton = this.page.locator(confirmSelector).first();
              if (await confirmButton.isVisible({ timeout: ELEMENT_TIMEOUT_MS })) {
                console.log(`✅ Found confirmation button: ${confirmSelector}`);
                await confirmButton.click();
                await this.page.waitForTimeout(WAIT_BETWEEN_ACTIONS_MS);
                console.log(`✅ Clicked confirmation button`);
                break;
              }
            } catch (e) { continue; }
          }

          return true;
        }, 'apply_to_job', 2);

        if (applyResult) {
          this.appliedJobs.add(jobId);
          applied = true;
          reason = `AI recommended with ${analysis.confidenceScore}% confidence`;
          console.log(`✅ SUCCESSFULLY APPLIED (${applicationsCount + 1}/${maxApplications}): ${jobTitle}`);
        } else {
          reason = 'AI recommended but application process failed';
          errors.push('Application button interaction failed');
          console.log(`❌ AI recommended but couldn't complete application: ${jobTitle}`);
        }
      } else {
        reason = analysis.shouldApply ? 
          `Confidence too low (${analysis.confidenceScore}% < ${minConfidence}%)` :
          'AI determined not a good match';
        console.log(`⏭️ Skipped: ${reason}`);
      }

      // Navigate back to job list
// After job processing, handle going back to original tab
try {
  if (this.context!.pages().length > 1) {
    // Close the job details tab and switch back to search results
    await this.page.close();
    
    // Switch back to the main search results page
    const pages = this.context!.pages();
    this.page = pages[0]; // Usually the first page is the search results
    
    console.log(`↩️ Closed job tab and returned to search results`);
  } else {
    // Same tab, just go back
    await this.page.goBack();
    console.log(`↩️ Navigated back to job list`);
  }
  
  await this.page.waitForTimeout(2000);
  
} catch (backError) {
  console.log(`⚠️ Error navigating back: ${backError}`);
}


      return {
        jobTitle,
        company,
        companyRating,
        location,
        experience,
        salary,
        skills,
        postedDate,
        analysis,
        applied,
        reason,
        errors,
        fixes,
        excluded: false
      };
    }, contextId, 2);
  }

  // Enhanced fallback analysis with exclusion check
  private fallbackJobAnalysis(jobTitle: string, jobDescription: string): boolean {
    const text = `${jobTitle} ${jobDescription}`.toLowerCase();
    const userSkills = this.credentials.userProfile.skills.map(skill => skill.toLowerCase());
    const jobKeywords = this.credentials.jobPreferences.keywords.map(keyword => keyword.toLowerCase());
    
    // Check exclude keywords
    const excludeKeywords = this.credentials.jobPreferences.excludeKeywords.map(keyword => keyword.toLowerCase());
    const hasExcludedTerms = excludeKeywords.some(term => text.includes(term));
    
    if (hasExcludedTerms) {
      return false; // Don't apply if contains excluded terms
    }
    
    const hasMatchingSkills = userSkills.some(skill => text.includes(skill));
    const hasMatchingKeywords = jobKeywords.some(keyword => text.includes(keyword));
    
    return hasMatchingSkills || hasMatchingKeywords;
  }

  private async navigateToNextPage(currentPage: number, applicationsCount: number, maxApplications: number): Promise<{ success: boolean }> {
    const result = await this.executeWithErrorRecovery(async () => {
      if (!this.page) throw new Error('Page not available');

      // Updated pagination selectors based on HTML structure
      const nextSelectors = [
        '.styles_btn-secondary__2AsIP:has-text("Next"):not([disabled])',
        'a:has-text("Next")',
        '.pagination-next',
        'a[title="Next"]',
        '.next-page'
      ];

      for (const selector of nextSelectors) {
        try {
          const nextButton = this.page.locator(selector).first();
          if (await nextButton.isVisible() && applicationsCount < maxApplications) {
            const isDisabled = await nextButton.getAttribute('disabled');
            if (!isDisabled) {
              console.log(`📄 Moving to page ${currentPage + 1}...`);
              await nextButton.click();
              await this.page.waitForLoadState('domcontentloaded', { timeout: GLOBAL_TIMEOUT_MS });
              await this.page.waitForTimeout(WAIT_BETWEEN_ACTIONS_MS);
              return { success: true };
            }
          }
        } catch (e) { continue; }
      }

      console.log('No more pages available or reached application limit');
      return { success: false };
    }, 'navigate_to_next_page', 2);

    return result || { success: false };
  }

  private generateSelfHealingReport(): void {
    console.log('\n' + '='.repeat(70));
    console.log('🤖 SELF-HEALING AI-POWERED JOB APPLICATION REPORT');
    console.log('='.repeat(70));

    const totalAnalyzed = this.applicationResults.length;
    const totalApplied = this.applicationResults.filter(r => r.applied).length;
    const totalExcluded = this.excludedJobs.length;
    const averageConfidence = totalAnalyzed > 0 ? 
      this.applicationResults.reduce((sum, r) => sum + r.analysis.confidenceScore, 0) / totalAnalyzed : 0;

    console.log(`📊 APPLICATION SUMMARY:`);
    console.log(`   Jobs Analyzed: ${totalAnalyzed}`);
    console.log(`   Jobs Excluded: ${totalExcluded}`);
    console.log(`   Applications Sent: ${totalApplied}`);
    console.log(`   Success Rate: ${((totalApplied / Math.max(totalAnalyzed, 1)) * 100).toFixed(1)}%`);
    console.log(`   Average AI Confidence: ${averageConfidence.toFixed(1)}%`);

    // Exclusion statistics
    if (totalExcluded > 0) {
      console.log(`\n🚫 EXCLUSION BREAKDOWN:`);
      const exclusionReasons = this.excludedJobs.reduce((acc, job) => {
        const reason = job.exclusionReason || 'Unknown';
        acc.set(reason, (acc.get(reason) || 0) + 1);
        return acc;
      }, new Map<string, number>());

      for (const [reason, count] of exclusionReasons.entries()) {
        console.log(`   ${reason}: ${count} jobs`);
      }

      console.log(`\n🚫 EXCLUDED JOBS:`);
      this.excludedJobs.forEach((job, index) => {
        console.log(`   ${index + 1}. ${job.jobTitle} at ${job.company}`);
        console.log(`      Reason: ${job.exclusionReason}`);
      });
    }

    console.log(`\n🔧 ERROR RECOVERY STATS:`);
    console.log(`   Total Errors Encountered: ${this.errorStats.totalErrors}`);
    console.log(`   Errors Fixed Automatically: ${this.errorStats.fixedErrors}`);
    console.log(`   Self-Healing Success Rate: ${this.errorStats.totalErrors > 0 ? ((this.errorStats.fixedErrors / this.errorStats.totalErrors) * 100).toFixed(1) : 0}%`);

    console.log(`\n📈 ERROR TYPES:`);
    for (const [errorType, count] of this.errorStats.errorTypes.entries()) {
      console.log(`   ${errorType}: ${count} times`);
    }

    console.log(`\n✅ SUCCESSFUL APPLICATIONS:`);
    this.applicationResults
      .filter(r => r.applied)
      .forEach((result, index) => {
        console.log(`   ${index + 1}. ${result.jobTitle} at ${result.company}`);
        console.log(`      Confidence: ${result.analysis.confidenceScore}%`);
        console.log(`      Skills Match: ${result.analysis.matchedSkills.join(', ')}`);
        if (result.location) console.log(`      Location: ${result.location}`);
        if (result.salary && result.salary !== 'Not specified') console.log(`      Salary: ${result.salary}`);
      });

    console.log(`\n📋 DETAILED JOB ANALYSIS:`);
    this.applicationResults.forEach((result, index) => {
      console.log(`\n${index + 1}. ${result.jobTitle} - ${result.company}`);
      console.log(`   Applied: ${result.applied ? '✅' : '❌'}`);
      console.log(`   Reason: ${result.reason}`);
      if (result.companyRating) console.log(`   Company Rating: ${result.companyRating}`);
      if (result.skills && result.skills.length > 0) {
        console.log(`   Required Skills: ${result.skills.join(', ')}`);
      }
      if (result.postedDate) console.log(`   Posted: ${result.postedDate}`);
    });
  }

  async start(): Promise<void> {
    try {
      console.log('🚀 Starting Self-Healing Intelligent Naukri Bot...\n');
      console.log(`👤 Profile: ${this.credentials.userProfile.name}`);
      console.log(`🎯 Target: ${this.credentials.jobPreferences.keywords.join(', ')}`);
      console.log(`📍 Location: ${this.credentials.jobPreferences.location}`);
      console.log(`🔧 Max Retries: ${this.credentials.jobPreferences.maxRetryAttempts}`);
      console.log(`🎯 Min Confidence: ${this.credentials.jobPreferences.minimumConfidenceScore}%`);
      if (this.credentials.jobPreferences.excludeCompanies.length > 0) {
        //console.log(`🚫 Excluded Companies: ${this.credentials.jobPreferences.excludeCompanies.join(', ')}`);
        console.log(`🚫 Excluded Companies: Private Information`);
      }
      if (this.credentials.jobPreferences.excludeKeywords.length > 0) {
        console.log(`🚫 Excluded Keywords: ${this.credentials.jobPreferences.excludeKeywords.join(', ')}`);
      }
      console.log('');

      await this.ensureBrowserReady();
      await this.loginToNaukri();
      await this.searchJobs();
      await this.analyzeAndApplyToJobs();
      
      this.generateSelfHealingReport();

    } catch (error) {
      const err = error as Error;
      console.error('❌ Critical Error:', err.message);
    } finally {
      if (this.browser) {
        console.log('\n⏳ Review complete. Closing browser in 15 seconds...');
        await new Promise(resolve => setTimeout(resolve, 15000));
        await this.browser.close();
      }
    }
  }
}

// Export and run the self-healing intelligent bot
const bot = new SelfHealingIntelligentNaukriBot();
bot.start().catch(console.error);
