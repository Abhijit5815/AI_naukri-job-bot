#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { chromium, Browser, Page, BrowserContext } from 'playwright';

interface JobPreferences {
  keywords: string[];
  location: string;
  experience: string;
  salary?: string;
  jobType?: string;
  excludeKeywords?: string[];
}

// Type for MCP arguments
interface MCPArguments {
  [key: string]: unknown;
}

class NaukriAutomationMCPServer {
  private server: Server;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private appliedJobs: Set<string> = new Set();

  constructor() {
    this.server = new Server(
      {
        name: 'naukri-automation-mcp',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'login_naukri',
            description: 'Login to Naukri.com with credentials',
            inputSchema: {
              type: 'object',
              properties: {
                email: {
                  type: 'string',
                  description: 'Email address for Naukri login'
                },
                password: {
                  type: 'string',
                  description: 'Password for Naukri login'
                }
              },
              required: ['email', 'password']
            }
          },
          {
            name: 'search_jobs',
            description: 'Search for jobs based on preferences',
            inputSchema: {
              type: 'object',
              properties: {
                keywords: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Job search keywords'
                },
                location: {
                  type: 'string',
                  description: 'Job location'
                },
                experience: {
                  type: 'string',
                  description: 'Experience level (e.g., "2-5 years")'
                },
                salary: {
                  type: 'string',
                  description: 'Expected salary range (optional)'
                }
              },
              required: ['keywords', 'location', 'experience']
            }
          },
          {
            name: 'apply_to_jobs',
            description: 'Apply to all matching jobs found in search results',
            inputSchema: {
              type: 'object',
              properties: {
                maxApplications: {
                  type: 'number',
                  description: 'Maximum number of applications to send',
                  default: 50
                },
                excludeKeywords: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Keywords to exclude from job titles'
                }
              }
            }
          },
          {
            name: 'get_application_status',
            description: 'Get status of job applications',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          }
        ] as Tool[]
      };
    });

    // Fixed request handler with proper type checking
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        await this.ensureBrowserReady();

        // Proper type checking for args
        const typedArgs = args as MCPArguments | undefined;
        
        if (!typedArgs) {
          throw new Error('Missing arguments for tool call');
        }

        switch (name) {
          case 'login_naukri': {
            const email = this.validateString(typedArgs.email, 'email');
            const password = this.validateString(typedArgs.password, 'password');
            return await this.loginToNaukri(email, password);
          }

          case 'search_jobs': {
            const keywords = this.validateStringArray(typedArgs.keywords, 'keywords');
            const location = this.validateString(typedArgs.location, 'location');
            const experience = this.validateString(typedArgs.experience, 'experience');
            const salary = this.validateOptionalString(typedArgs.salary);
            
            return await this.searchJobs({
              keywords,
              location,
              experience,
              salary
            });
          }

          case 'apply_to_jobs': {
            const maxApplications = this.validateNumber(typedArgs.maxApplications, 50);
            const excludeKeywords = this.validateOptionalStringArray(typedArgs.excludeKeywords);
            
            return await this.applyToJobs(maxApplications, excludeKeywords);
          }

          case 'get_application_status':
            return await this.getApplicationStatus();

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    });
  }

  // Helper methods for type validation
  private validateString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string') {
      throw new Error(`${fieldName} must be a string`);
    }
    return value;
  }

  private validateOptionalString(value: unknown): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new Error('Value must be a string or undefined');
    }
    return value;
  }

  private validateStringArray(value: unknown, fieldName: string): string[] {
    if (!Array.isArray(value)) {
      throw new Error(`${fieldName} must be an array`);
    }
    if (!value.every(item => typeof item === 'string')) {
      throw new Error(`${fieldName} must be an array of strings`);
    }
    return value as string[];
  }

  private validateOptionalStringArray(value: unknown): string[] {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error('Value must be an array or undefined');
    }
    if (!value.every(item => typeof item === 'string')) {
      throw new Error('Array must contain only strings');
    }
    return value as string[];
  }

  private validateNumber(value: unknown, defaultValue: number): number {
    if (value === undefined || value === null) {
      return defaultValue;
    }
    if (typeof value !== 'number') {
      throw new Error('Value must be a number');
    }
    return value;
  }

  private async ensureBrowserReady(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({ 
        headless: false,
        devtools: false,
        slowMo: 1000
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

  private async loginToNaukri(email: string, password: string) {
    if (!this.page) throw new Error('Browser not initialized');

    try {
      console.log('🔐 Attempting to login to Naukri...');
      
      await this.page.goto('https://www.naukri.com/nlogin/login');
      await this.page.waitForLoadState('networkidle');

      await this.page.fill('#usernameField', email);
      await this.page.waitForTimeout(1000);

      await this.page.fill('#passwordField', password);
      await this.page.waitForTimeout(1000);

      await this.page.click('button[type="submit"]');
      await this.page.waitForLoadState('networkidle');

      const isLoggedIn = await this.page.waitForSelector('.nI-gNb-drawer__icon', { timeout: 10000 }).catch(() => null);
      
      if (isLoggedIn) {
        console.log('✅ Successfully logged into Naukri');
        return {
          content: [
            {
              type: 'text',
              text: 'Successfully logged into Naukri.com'
            }
          ]
        };
      } else {
        throw new Error('Login failed - please check credentials');
      }
    } catch (error) {
      throw new Error(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async searchJobs(preferences: JobPreferences) {
    if (!this.page) throw new Error('Browser not initialized');

    try {
      console.log('🔍 Searching for jobs...');
      
      await this.page.goto('https://www.naukri.com/jobs');
      await this.page.waitForLoadState('networkidle');

      const keywordsString = preferences.keywords.join(' ');
      await this.page.fill('input[placeholder="Enter skills / designations / companies"]', keywordsString);
      await this.page.waitForTimeout(1000);

      await this.page.fill('input[placeholder="Enter location"]', preferences.location);
      await this.page.waitForTimeout(1000);

      await this.page.click('div[data-automation="experienceFilter"]').catch(() => {
        console.log('Could not find experience filter');
      });
      await this.page.waitForTimeout(500);

      await this.page.click('button[data-automation="searchButton"]');
      await this.page.waitForLoadState('networkidle');

      const jobCount = await this.page.locator('.jobTuple').count();
      console.log(`📊 Found ${jobCount} jobs`);

      return {
        content: [
          {
            type: 'text',
            text: `Search completed! Found ${jobCount} jobs matching your criteria:\nKeywords: ${keywordsString}\nLocation: ${preferences.location}\nExperience: ${preferences.experience}`
          }
        ]
      };
    } catch (error) {
      throw new Error(`Job search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async applyToJobs(maxApplications: number, excludeKeywords: string[]) {
    if (!this.page) throw new Error('Browser not initialized');

    let applicationsCount = 0;
    let currentPage = 1;
    const appliedJobs: string[] = [];

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

            if (this.appliedJobs.has(jobId)) {
              continue;
            }

            const shouldExclude = excludeKeywords.some(keyword => 
              jobTitle.toLowerCase().includes(keyword.toLowerCase())
            );

            if (shouldExclude) {
              console.log(`⏭️  Skipping: ${jobTitle} (excluded keyword)`);
              continue;
            }

            console.log(`🎯 Attempting to apply: ${jobTitle} at ${company}`);

            await jobCard.click();
            await this.page.waitForTimeout(2000);

            const applyButton = await this.page.locator('button:has-text("Apply"), a:has-text("Apply")').first();
            
            if (await applyButton.isVisible()) {
              await applyButton.click();
              await this.page.waitForTimeout(3000);

              const confirmButton = await this.page.locator('button:has-text("Confirm"), button:has-text("Submit Application")').first();
              if (await confirmButton.isVisible({ timeout: 5000 })) {
                await confirmButton.click();
                await this.page.waitForTimeout(2000);
              }

              this.appliedJobs.add(jobId);
              appliedJobs.push(`${jobTitle} at ${company}`);
              applicationsCount++;

              console.log(`✅ Applied (${applicationsCount}/${maxApplications}): ${jobTitle}`);
            } else {
              console.log(`❌ No apply button found for: ${jobTitle}`);
            }

            await this.page.goBack();
            await this.page.waitForTimeout(2000);

          } catch (jobError) {
            console.log(`⚠️  Error applying to job: ${jobError}`);
            continue;
          }
        }

        const nextPageButton = await this.page.locator('a:has-text("Next")').first();
        if (await nextPageButton.isVisible() && applicationsCount < maxApplications) {
          await nextPageButton.click();
          await this.page.waitForLoadState('networkidle');
          currentPage++;
        } else {
          break;
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `Job application process completed!\n\nApplications sent: ${applicationsCount}\nPages searched: ${currentPage}\n\nApplied to:\n${appliedJobs.map((job, index) => `${index + 1}. ${job}`).join('\n')}`
          }
        ]
      };

    } catch (error) {
      throw new Error(`Job application failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async getApplicationStatus() {
    return {
      content: [
        {
          type: 'text',
          text: `Application Status:\nTotal jobs applied: ${this.appliedJobs.size}\nApplied job IDs: ${Array.from(this.appliedJobs).join(', ')}`
        }
      ]
    };
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    
    process.on('SIGINT', async () => {
      if (this.browser) {
        await this.browser.close();
      }
      process.exit(0);
    });
  }
}

if (require.main === module) {
  const server = new NaukriAutomationMCPServer();
  server.run().catch(console.error);
}
