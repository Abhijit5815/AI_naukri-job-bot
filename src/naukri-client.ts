import * as fs from 'fs';
import * as path from 'path';
import { chromium, Browser, Page, BrowserContext } from 'playwright';

interface Credentials {
  naukri: {
    email: string;
    password: string;
  };
  jobPreferences: {
    keywords: string[];
    location: string;
    experience: string;
    salary?: string;
    maxApplications: number;
    excludeKeywords: string[];
  };
}

class NaukriJobApplicant {
  private credentials: Credentials;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private appliedJobs: Set<string> = new Set();
  
  constructor() {
    this.credentials = this.loadCredentials();
  }

  private loadCredentials(): Credentials {
    const credentialsPath = path.join(__dirname, 'config', 'credentials.json');
    
    try {
      const credentialsData = fs.readFileSync(credentialsPath, 'utf8');
      const credentials = JSON.parse(credentialsData) as Credentials;
      console.log('✅ Credentials loaded successfully');
      return credentials;
    } catch (error) {
      console.error('❌ Error loading credentials file:');
      console.error('Please run: npm run setup');
      console.error('Or manually create src/config/credentials.json using the template');
      process.exit(1);
    }
  }

  private async ensureBrowserReady(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({ 
        headless: false,
        devtools: false,
        slowMo: 2000 // Increased delay between actions
      });
    }

    if (!this.context) {
      this.context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      });
    }

    if (!this.page) {
      this.page = await this.context.newPage();
    }
  }

  private async loginToNaukri(): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');

    try {
      console.log('🔐 Attempting to login to Naukri...');
      
      await this.page.goto('https://www.naukri.com/nlogin/login');
      await this.page.waitForLoadState('networkidle', { timeout: 60000 }); // Increased timeout

      await this.page.fill('#usernameField', this.credentials.naukri.email);
      await this.page.waitForTimeout(2000); // Increased delay

      await this.page.fill('#passwordField', this.credentials.naukri.password);
      await this.page.waitForTimeout(2000); // Increased delay

      await this.page.click('button[type="submit"]');
      
      // Wait longer and try multiple indicators of successful login
      console.log('⏳ Waiting for login to complete...');
      
      try {
        // Try multiple selectors that indicate successful login
        await Promise.race([
          this.page.waitForSelector('.nI-gNb-drawer__icon', { timeout: 45000 }),
          this.page.waitForSelector('[data-automation="mNaukriLogo"]', { timeout: 45000 }),
          this.page.waitForSelector('.nI-gNb-menuIcon', { timeout: 45000 }),
          this.page.waitForURL('https://www.naukri.com/mnjuser/homepage', { timeout: 45000 })
        ]);
        
        console.log('✅ Successfully logged into Naukri');
      } catch (waitError) {
        // Check if we're on the homepage anyway
        const currentUrl = this.page.url();
        console.log(`Current URL after login: ${currentUrl}`);
        
        if (currentUrl.includes('naukri.com') && !currentUrl.includes('login')) {
          console.log('✅ Login appears successful (detected by URL)');
        } else {
          // Check if there's a CAPTCHA or other verification
          const captcha = await this.page.locator('img[alt*="captcha"], .captcha, [id*="captcha"]').first().isVisible().catch(() => false);
          if (captcha) {
            console.log('⚠️  CAPTCHA detected! Please solve it manually in the browser and press Enter to continue...');
            // Wait for user input
            await new Promise(resolve => {
              const readline = require('readline');
              const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
              });
              rl.question('Press Enter after solving CAPTCHA: ', () => {
                rl.close();
                resolve(null);
              });
            });
          } else {
            console.log('⚠️  Login may need manual verification. Waiting 10 seconds for manual intervention...');
            await this.page.waitForTimeout(10000);
            
            // Check again after waiting
            const finalUrl = this.page.url();
            if (finalUrl.includes('naukri.com') && !finalUrl.includes('login')) {
              console.log('✅ Login completed successfully');
            } else {
              throw new Error('Login verification failed - please check your credentials or try again');
            }
          }
        }
      }
    } catch (error) {
      throw new Error(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async searchJobs(): Promise<number> {
    if (!this.page) throw new Error('Browser not initialized');

    try {
      console.log('🔍 Searching for jobs...');
      
      await this.page.goto('https://www.naukri.com/jobs');
      await this.page.waitForLoadState('networkidle');

      const keywordsString = this.credentials.jobPreferences.keywords.join(' ');
      await this.page.fill('input[placeholder="Enter skills / designations / companies"]', keywordsString);
      await this.page.waitForTimeout(1000);

      // Split locations and use the first one for search
      const locations = this.credentials.jobPreferences.location.split(',');
      const primaryLocation = locations[0].trim();
      
      await this.page.fill('input[placeholder="Enter location"]', primaryLocation);
      await this.page.waitForTimeout(1000);

      // Try to set experience filter
      try {
        await this.page.click('div[data-automation="experienceFilter"]');
        await this.page.waitForTimeout(500);
        
        // Look for experience option - this might need adjustment based on actual UI
        const experienceOption = this.page.locator(`text="${this.credentials.jobPreferences.experience}"`).first();
        if (await experienceOption.isVisible({ timeout: 3000 })) {
          await experienceOption.click();
        }
      } catch (expError) {
        console.log('Could not set experience filter - continuing without it');
      }

      await this.page.click('button[data-automation="searchButton"]');
      await this.page.waitForLoadState('networkidle');

      const jobCount = await this.page.locator('.jobTuple').count();
      console.log(`📊 Found ${jobCount} jobs matching your criteria`);
      
      return jobCount;
    } catch (error) {
      throw new Error(`Job search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async applyToJobs(): Promise<{ applicationsCount: number; appliedJobs: string[] }> {
    if (!this.page) throw new Error('Browser not initialized');

    let applicationsCount = 0;
    let currentPage = 1;
    const appliedJobs: string[] = [];
    const maxApplications = this.credentials.jobPreferences.maxApplications;
    const excludeKeywords = this.credentials.jobPreferences.excludeKeywords;

    try {
      console.log(`🎯 Starting to apply to jobs (max: ${maxApplications})`);
      
      while (applicationsCount < maxApplications) {
        console.log(`📄 Processing page ${currentPage}...`);
        
        const jobCards = await this.page.locator('.jobTuple').all();
        
        if (jobCards.length === 0) {
          console.log('No more jobs found');
          break;
        }

        for (const jobCard of jobCards) {
          if (applicationsCount >= maxApplications) break;

          try {
            const titleElement = await jobCard.locator('.title').first();
            const companyElement = await jobCard.locator('.companyInfo .subTitle').first();
            
            const jobTitle = await titleElement.textContent() || '';
            const company = await companyElement.textContent() || '';
            const jobId = await jobCard.getAttribute('data-job-id') || `${jobTitle}-${company}`;

            // Skip if already applied
            if (this.appliedJobs.has(jobId)) {
              continue;
            }

            // Check for excluded keywords
            const shouldExclude = excludeKeywords.some(keyword => 
              jobTitle.toLowerCase().includes(keyword.toLowerCase())
            );

            if (shouldExclude) {
              console.log(`⏭️  Skipping: ${jobTitle} (excluded keyword)`);
              continue;
            }

            console.log(`🎯 Attempting to apply: ${jobTitle} at ${company}`);

            // Click on job card to open details
            await jobCard.click();
            await this.page.waitForTimeout(2000);

            // Look for apply button
            const applyButton = await this.page.locator('button:has-text("Apply"), a:has-text("Apply"), .apply').first();
            
            if (await applyButton.isVisible({ timeout: 5000 })) {
              await applyButton.click();
              await this.page.waitForTimeout(3000);

              // Handle any confirmation dialogs
              const confirmButton = await this.page.locator('button:has-text("Confirm"), button:has-text("Submit Application"), button:has-text("Apply Now")').first();
              if (await confirmButton.isVisible({ timeout: 5000 })) {
                await confirmButton.click();
                await this.page.waitForTimeout(2000);
              }

              // Check for success message
              const successMessage = await this.page.locator('text="Application sent successfully", text="Applied successfully", .success').first().isVisible({ timeout: 3000 }).catch(() => false);
              
              if (successMessage) {
                this.appliedJobs.add(jobId);
                appliedJobs.push(`${jobTitle} at ${company}`);
                applicationsCount++;
                console.log(`✅ Applied (${applicationsCount}/${maxApplications}): ${jobTitle}`);
              } else {
                console.log(`⚠️  Application may not have completed for: ${jobTitle}`);
              }
            } else {
              console.log(`❌ No apply button found for: ${jobTitle}`);
            }

            // Go back to job list
            await this.page.goBack();
            await this.page.waitForTimeout(2000);

          } catch (jobError) {
            console.log(`⚠️  Error applying to job: ${jobError}`);
            // Try to go back to job list if we got stuck
            try {
              await this.page.goBack();
              await this.page.waitForTimeout(1000);
            } catch (backError) {
              console.log('Could not go back, continuing...');
            }
            continue;
          }
        }

        // Try to go to next page
        const nextPageButton = await this.page.locator('a:has-text("Next"), .np:has-text("Next")').first();
        if (await nextPageButton.isVisible() && applicationsCount < maxApplications) {
          console.log(`📄 Moving to page ${currentPage + 1}...`);
          await nextPageButton.click();
          await this.page.waitForLoadState('networkidle');
          currentPage++;
        } else {
          console.log('No more pages available or reached application limit');
          break;
        }
      }

      return { applicationsCount, appliedJobs };

    } catch (error) {
      throw new Error(`Job application failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async startJobApplication(): Promise<void> {
    try {
      console.log('🚀 Starting Naukri Job Application Bot...\n');
      console.log(`📧 Email: ${this.credentials.naukri.email}`);
      console.log(`📍 Location: ${this.credentials.jobPreferences.location}`);
      console.log(`🎯 Keywords: ${this.credentials.jobPreferences.keywords.join(', ')}`);
      console.log(`🚫 Exclude: ${this.credentials.jobPreferences.excludeKeywords.join(', ')}\n`);

      // Initialize browser
      await this.ensureBrowserReady();

      // Step 1: Login
      console.log('Step 1: Logging into Naukri...');
      await this.loginToNaukri();
      console.log('✅ Login successful!\n');

      // Step 2: Search for jobs
      console.log('Step 2: Searching for jobs...');
      const jobCount = await this.searchJobs();
      console.log('✅ Job search completed!\n');

      if (jobCount === 0) {
        console.log('❌ No jobs found matching your criteria. Try adjusting your search keywords or location.');
        return;
      }

      // Step 3: Apply to jobs
      console.log('Step 3: Starting job applications...');
      const result = await this.applyToJobs();
      
      console.log('\n✅ Job application process completed!');
      console.log(`📊 Applications sent: ${result.applicationsCount}`);
      
      if (result.appliedJobs.length > 0) {
        console.log(`📋 Successfully applied to:\n${result.appliedJobs.map((job, index) => `${index + 1}. ${job}`).join('\n')}`);
      } else {
        console.log('❌ No applications were successfully submitted. This could be due to:');
        console.log('   - Jobs requiring manual application');
        console.log('   - Network issues');
        console.log('   - Changed UI elements on Naukri');
        console.log('   - All jobs filtered out by exclude keywords');
      }

    } catch (error) {
      console.error('❌ Error:', error);
    } finally {
      if (this.browser) {
        console.log('\n⏳ Keeping browser open for 10 seconds for review...');
        await new Promise(resolve => setTimeout(resolve, 10000));
        await this.browser.close();
        console.log('🧹 Browser closed');
      }
    }
  }
}

// Create and run the bot
const bot = new NaukriJobApplicant();
bot.startJobApplication().catch(console.error);
