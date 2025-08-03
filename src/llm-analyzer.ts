import * as fs from 'fs';
import * as path from 'path';

export interface JobAnalysis {
  shouldApply: boolean;
  confidenceScore: number;
  reasoning: string;
  matchedSkills: string[];
  concerns: string[];
}

interface OllamaConfig {
  provider: 'ollama';
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

interface OllamaResponse {
  message: {
    role: string;
    content: string;
  };
  done: boolean;
}

// Dynamic company matching patterns
interface CompanyPattern {
  keywords: string[];
  aliases: string[];
  subsidiaries: string[];
  commonSuffixes: string[];
}

export class LLMJobAnalyzer {
  private config: OllamaConfig;
  private userProfile: string;
  private userSkills: string[];
  private userKeywords: string[];
  private companyPatterns: Map<string, CompanyPattern>;

  constructor(userProfile: string) {
    this.userProfile = userProfile;
    this.config = this.loadConfig();
    
    // Extract skills and keywords from user profile
    this.userSkills = this.extractSkillsFromProfile(userProfile);
    this.userKeywords = this.extractKeywordsFromProfile(userProfile);
    
    // Initialize dynamic company patterns
    this.companyPatterns = this.initializeCompanyPatterns();
  }

  private initializeCompanyPatterns(): Map<string, CompanyPattern> {
    // Load company patterns from config or create dynamic ones
    const patternsPath = path.join(__dirname, 'config', 'company-patterns.json');
    
    try {
      if (fs.existsSync(patternsPath)) {
        const patternsData = fs.readFileSync(patternsPath, 'utf8');
        const patterns = JSON.parse(patternsData);
        return new Map(Object.entries(patterns));
      }
    } catch (error) {
      console.log('⚠️ Company patterns file not found, using default patterns');
    }

    // Default dynamic patterns
    return new Map();
  }

  private generateCompanyPattern(companyName: string): CompanyPattern {
    const name = companyName.toLowerCase().trim();
    
    // Common business suffixes that should be ignored during matching
    const commonSuffixes = [
      'pvt ltd', 'private limited', 'ltd', 'limited', 'inc', 'incorporated', 
      'corp', 'corporation', 'llc', 'technologies', 'technology', 'tech',
      'software', 'solutions', 'services', 'systems', 'group', 'company', 
      'co', 'enterprises', 'consultancy', 'consulting', 'labs', 'laboratory'
    ];

    // Extract core company name by removing suffixes
    let coreName = name;
    for (const suffix of commonSuffixes) {
      const regex = new RegExp(`\\s+${suffix}$`, 'i');
      coreName = coreName.replace(regex, '').trim();
    }

    // Generate possible aliases and variations
    const aliases = [
      coreName,
      name, // full name
      coreName.replace(/\s+/g, ''), // no spaces
      coreName.replace(/\s+/g, '_'), // underscores
      coreName.replace(/\s+/g, '-'), // hyphens
    ];

    // Add acronym if multiple words
    const words = coreName.split(/\s+/);
    if (words.length > 1) {
      const acronym = words.map(word => word.charAt(0)).join('');
      aliases.push(acronym);
    }

    return {
      keywords: [coreName],
      aliases: [...new Set(aliases)], // Remove duplicates
      subsidiaries: [], // Can be populated based on known subsidiaries
      commonSuffixes
    };
  }

  private isCompanyExcluded(companyName: string, excludedCompanies: string[]): { excluded: boolean; reason: string; matchedPattern: string } {
    const company = companyName.toLowerCase().trim();
    
    for (const excludedCompany of excludedCompanies) {
      const excluded = excludedCompany.toLowerCase().trim();
      
      // Get or generate pattern for this excluded company
      let pattern = this.companyPatterns.get(excluded);
      if (!pattern) {
        pattern = this.generateCompanyPattern(excluded);
        this.companyPatterns.set(excluded, pattern);
      }

      // Check direct matches with all aliases
      for (const alias of pattern.aliases) {
        if (company.includes(alias) || alias.includes(company)) {
          return {
            excluded: true,
            reason: `Company "${companyName}" matches excluded pattern "${excludedCompany}" (alias: ${alias})`,
            matchedPattern: alias
          };
        }
      }

      // Check if company name contains the excluded pattern (fuzzy matching)
      if (this.fuzzyMatch(company, excluded)) {
        return {
          excluded: true,
          reason: `Company "${companyName}" fuzzy matches excluded pattern "${excludedCompany}"`,
          matchedPattern: excluded
        };
      }

      // Check for common variations and known mappings
      const variations = this.getCompanyVariations(excluded);
      for (const variation of variations) {
        if (company.includes(variation) || variation.includes(company)) {
          return {
            excluded: true,
            reason: `Company "${companyName}" matches excluded pattern "${excludedCompany}" (variation: ${variation})`,
            matchedPattern: variation
          };
        }
      }
    }

    return {
      excluded: false,
      reason: 'Company not in exclusion list',
      matchedPattern: ''
    };
  }

  private fuzzyMatch(company: string, pattern: string): boolean {
    // Remove common suffixes for better matching
    const cleanCompany = this.cleanCompanyName(company);
    const cleanPattern = this.cleanCompanyName(pattern);
    
    // Simple fuzzy matching - check if pattern is substantially present in company name
    if (cleanCompany.includes(cleanPattern) || cleanPattern.includes(cleanCompany)) {
      return true;
    }

    // Check word-by-word matching
    const companyWords = cleanCompany.split(/\s+/);
    const patternWords = cleanPattern.split(/\s+/);
    
    // If pattern has multiple words, check if most words are present
    if (patternWords.length > 1) {
      const matchedWords = patternWords.filter(word => 
        companyWords.some(compWord => compWord.includes(word) || word.includes(compWord))
      );
      return matchedWords.length >= Math.ceil(patternWords.length * 0.7); // 70% word match
    }

    return false;
  }

  private cleanCompanyName(name: string): string {
    const commonSuffixes = [
      'pvt ltd', 'private limited', 'ltd', 'limited', 'inc', 'incorporated',
      'corp', 'corporation', 'llc', 'technologies', 'technology', 'tech',
      'software', 'solutions', 'services', 'systems', 'group', 'company',
      'co', 'enterprises', 'consultancy', 'consulting', 'labs', 'laboratory'
    ];

    let cleaned = name.toLowerCase().trim();
    
    // Remove suffixes
    for (const suffix of commonSuffixes) {
      const regex = new RegExp(`\\s+${suffix}$`, 'i');
      cleaned = cleaned.replace(regex, '').trim();
    }

    return cleaned;
  }

  private getCompanyVariations(companyName: string): string[] {
    const variations: string[] = [];
    const name = companyName.toLowerCase();
    
    // Define known company variations dynamically
    const knownVariations: { [key: string]: string[] } = {
      'tcs': ['tata consultancy services', 'tata consultancy', 'tcs limited'],
      'wipro': ['wipro limited', 'wipro technologies', 'wipro infotech'],
      'infosys': ['infosys limited', 'infosys technologies', 'infosys consulting'],
      'accenture': ['accenture plc', 'accenture solutions', 'accenture services'],
      'ibm': ['international business machines', 'ibm india', 'ibm global'],
      'microsoft': ['microsoft corporation', 'microsoft india', 'microsoft technologies'],
      'amazon': ['amazon web services', 'aws', 'amazon india'],
      'google': ['alphabet inc', 'google india', 'google cloud'],
      'oracle': ['oracle corporation', 'oracle india', 'oracle systems'],
      'sap': ['sap se', 'sap labs', 'sap india'],
    };

    // Add predefined variations if they exist
    if (knownVariations[name]) {
      variations.push(...knownVariations[name]);
    }

    // Generate dynamic variations
    const words = name.split(/\s+/);
    
    if (words.length === 1) {
      // Single word company - generate common variations
      variations.push(
        `${name} limited`,
        `${name} pvt ltd`,
        `${name} technologies`,
        `${name} software`,
        `${name} solutions`,
        `${name} systems`,
        `${name} services`,
        `${name} consultancy`,
        `${name} corporation`,
        `${name} inc`
      );
    } else {
      // Multi-word company - create acronym and variations
      const acronym = words.map(word => word.charAt(0)).join('');
      variations.push(acronym);
      
      // Add variations with different suffixes
      const baseName = words.join(' ');
      variations.push(
        `${baseName} limited`,
        `${baseName} pvt ltd`,
        `${baseName} corporation`
      );
    }

    return [...new Set(variations)]; // Remove duplicates
  }

  private loadConfig(): OllamaConfig {
    const configPath = path.join(__dirname, 'config', 'llm-config.json');
    
    try {
      const configData = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configData) as OllamaConfig;
      
      // Set defaults
      if (!config.baseUrl) config.baseUrl = 'http://localhost:11434';
      if (!config.temperature) config.temperature = 0.3;
      if (!config.maxTokens) config.maxTokens = 1000;
      if (!config.model) config.model = 'llama3.2';
      
      console.log(`✅ Ollama Config loaded: ${config.model} at ${config.baseUrl}`);
      return config;
    } catch (error) {
      console.log('⚠️ LLM config not found, using default Ollama configuration');
      return {
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'llama3.2:latest',
        temperature: 0.3,
        maxTokens: 1000
      };
    }
  }

  private async makeOllamaRequest(prompt: string): Promise<string> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: 'system',
              content: 'You are an expert job analysis AI assistant. You help job seekers make intelligent decisions about job applications based on their profile and career goals. Always respond with valid JSON format.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          stream: false,
          options: {
            temperature: this.config.temperature,
            num_predict: this.config.maxTokens
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as OllamaResponse;
      return data.message.content;
    } catch (error) {
      console.error('Error making Ollama API call:', error);
      throw error;
    }
  }

  private extractSkillsFromProfile(profile: string): string[] {
    const skillsMatch = profile.match(/Skills:\s*([^\n]+)/i);
    if (skillsMatch) {
      return skillsMatch[1].split(',').map(skill => skill.trim().toLowerCase());
    }
    return [];
  }

  private extractKeywordsFromProfile(profile: string): string[] {
    const keywords: string[] = [];
    
    const roleMatch = profile.match(/Current Role:\s*([^\n]+)/i);
    if (roleMatch) {
      keywords.push(...roleMatch[1].toLowerCase().split(/\s+/));
    }
    
    const goalsMatch = profile.match(/Career Goals:\s*([^\n]+)/i);
    if (goalsMatch) {
      keywords.push(...goalsMatch[1].toLowerCase().split(/\s+/));
    }
    
    return keywords.filter(keyword => keyword.length > 2);
  }

  async analyzeJob(
    jobTitle: string, 
    company: string, 
    jobDescription: string, 
    salary: string
  ): Promise<JobAnalysis> {
    const prompt = `
Analyze this job opportunity for the following candidate profile and provide a recommendation.

CANDIDATE PROFILE:
${this.userProfile}

JOB DETAILS:
- Title: ${jobTitle}
- Company: ${company}
- Salary: ${salary}
- Description: ${jobDescription}

ANALYSIS INSTRUCTIONS:
1. Evaluate job fit based on:
   - Skills alignment with candidate's experience
   - Career growth potential
   - Role seniority match
   - Company reputation and culture fit
   - Salary competitiveness
   - Job responsibilities alignment

2. Consider RED FLAGS:
   - Skills mismatch (too junior/senior)
   - Poor company reviews or reputation
   - Unclear job descriptions
   - Unrealistic requirements
   - Low salary offers
   - Skills not matching current level

3. Provide analysis in this EXACT JSON format (no additional text):
{
  "shouldApply": boolean,
  "confidenceScore": number (0-100),
  "reasoning": "detailed explanation of decision",
  "matchedSkills": ["skill1", "skill2", "skill3"],
  "concerns": ["concern1", "concern2"]
}

IMPORTANT: 
- Be selective and realistic
- confidenceScore should reflect how well the job matches the profile
- Only recommend jobs with 70%+ confidence unless exceptional opportunity
- Focus on career growth and skill development
- Consider the candidate's experience level carefully
- RESPOND ONLY WITH VALID JSON, NO OTHER TEXT

Response:`;

    try {
      const response = await this.makeOllamaRequest(prompt);
      
      // Parse JSON response
      const cleanedResponse = response.trim();
      let jsonStart = cleanedResponse.indexOf('{');
      let jsonEnd = cleanedResponse.lastIndexOf('}') + 1;
      
      if (jsonStart === -1 || jsonEnd === 0) {
        throw new Error('No valid JSON found in response');
      }
      
      const jsonString = cleanedResponse.substring(jsonStart, jsonEnd);
      const analysis = JSON.parse(jsonString) as JobAnalysis;
      
      // Validate the response
      if (typeof analysis.shouldApply !== 'boolean' ||
          typeof analysis.confidenceScore !== 'number' ||
          typeof analysis.reasoning !== 'string' ||
          !Array.isArray(analysis.matchedSkills) ||
          !Array.isArray(analysis.concerns)) {
        throw new Error('Invalid analysis structure');
      }
      
      // Ensure confidence score is within bounds
      analysis.confidenceScore = Math.max(0, Math.min(100, analysis.confidenceScore));
      
      return analysis;
      
    } catch (error) {
      console.error('Error analyzing job with Ollama:', error);
      
      // Fallback to local analysis
      return this.localJobAnalysis(jobTitle, company, jobDescription, salary);
    }
  }

  async analyzeExclusion(prompt: string): Promise<string> {
    try {
      const shortPrompt = `${prompt}\n\nRespond with ONLY "EXCLUDE: [reason]" or "INCLUDE: Company not in exclusion list". No other text.`;
      const response = await this.makeOllamaRequest(shortPrompt);
      return response.trim();
    } catch (error) {
      console.error('Error in Ollama exclusion analysis:', error);
      
      // Fallback to local exclusion logic with dynamic matching
      const companyMatch = prompt.match(/Company:\s*([^\n]+)/i);
      const excludedCompaniesMatch = prompt.match(/Excluded Companies List:\s*([^\n]+)/i);
      
      if (!companyMatch || !excludedCompaniesMatch) {
        return 'INCLUDE: Unable to parse company information';
      }
      
      const company = companyMatch[1].trim();
      const excludedCompanies = excludedCompaniesMatch[1].split(',').map(c => c.trim());
      
      // Use dynamic exclusion logic
      const exclusionResult = this.isCompanyExcluded(company, excludedCompanies);
      
      if (exclusionResult.excluded) {
        return `EXCLUDE: ${exclusionResult.reason}`;
      }
      
      return 'INCLUDE: Company not in exclusion list';
    }
  }

  // Rest of the methods remain the same...
  private localJobAnalysis(
    jobTitle: string,
    company: string, 
    jobDescription: string,
    salary: string
  ): JobAnalysis {
    const jobText = `${jobTitle} ${jobDescription}`.toLowerCase();
    const companyText = company.toLowerCase();
    
    let confidenceScore = 0;
    const matchedSkills: string[] = [];
    const concerns: string[] = [];
    const reasoning: string[] = [];
    
    // Skill matching analysis
    let skillMatches = 0;
    for (const skill of this.userSkills) {
      if (jobText.includes(skill)) {
        matchedSkills.push(skill);
        skillMatches++;
        confidenceScore += 15;
      }
    }
    
    if (skillMatches > 0) {
      reasoning.push(`Found ${skillMatches} matching skills: ${matchedSkills.join(', ')}`);
    } else {
      concerns.push('No direct skill matches found');
      reasoning.push('Limited skill alignment detected');
    }
    
    // Keyword matching
    let keywordMatches = 0;
    for (const keyword of this.userKeywords) {
      if (jobText.includes(keyword)) {
        keywordMatches++;
        confidenceScore += 5;
      }
    }
    
    if (keywordMatches > 0) {
      reasoning.push(`Found ${keywordMatches} relevant keywords`);
    }
    
    // Experience level analysis
    const experienceMatch = this.userProfile.match(/Experience:\s*(\d+)/i);
    const userExperience = experienceMatch ? parseInt(experienceMatch[1]) : 0;
    
    if (jobText.includes('senior') && userExperience >= 5) {
      confidenceScore += 10;
      reasoning.push('Good match for senior-level experience');
    } else if (jobText.includes('junior') && userExperience < 3) {
      confidenceScore += 10;
      reasoning.push('Appropriate for junior-level experience');
    } else if (jobText.includes('lead') && userExperience >= 7) {
      confidenceScore += 15;
      reasoning.push('Suitable for leadership role experience');
    }
    
    // Red flags detection
    const redFlags = [
      'manual testing only', 'no automation', 'entry level only',
      'intern', 'trainee', 'unpaid'
    ];
    
    for (const redFlag of redFlags) {
      if (jobText.includes(redFlag)) {
        concerns.push(`Contains red flag: ${redFlag}`);
        confidenceScore -= 20;
      }
    }
    
    confidenceScore = Math.max(0, Math.min(100, confidenceScore));
    const shouldApply = confidenceScore >= 60 && matchedSkills.length >= 2;
    
    return {
      shouldApply,
      confidenceScore,
      reasoning: reasoning.join('. '),
      matchedSkills,
      concerns
    };
  }

  async testOllamaConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`);
      if (response.ok) {
        const data = await response.json();
        console.log(`✅ Ollama connection successful. Available models:`, data.models?.map((m: any) => m.name) || []);
        return true;
      }
      return false;
    } catch (error) {
      console.error('❌ Ollama connection failed:', error);
      return false;
    }
  }

  // Method to save learned company patterns
  saveCompanyPatterns(): void {
    const patternsPath = path.join(__dirname, 'config', 'company-patterns.json');
    try {
      const patterns = Object.fromEntries(this.companyPatterns);
      fs.writeFileSync(patternsPath, JSON.stringify(patterns, null, 2));
      console.log('✅ Company patterns saved successfully');
    } catch (error) {
      console.error('❌ Error saving company patterns:', error);
    }
  }
}

export const createLLMAnalyzer = (userProfile: string): LLMJobAnalyzer => {
  return new LLMJobAnalyzer(userProfile);
};

export default LLMJobAnalyzer;
