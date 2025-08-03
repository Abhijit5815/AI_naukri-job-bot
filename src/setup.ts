import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function setupCredentials() {
  console.log('🔧 Setting up your Naukri credentials...\n');

  const credentials = {
    naukri: {
      email: '',
      password: ''
    },
    jobPreferences: {
      keywords: [] as string[],
      location: '',
      experience: '',
      salary: '',
      maxApplications: 25,
      excludeKeywords: [] as string[]
    }
  };

  credentials.naukri.email = await question('Enter your Naukri email: ');
  credentials.naukri.password = await question('Enter your Naukri password: ');

  const keywordsInput = await question('Enter your skills/keywords (comma-separated): ');
  credentials.jobPreferences.keywords = keywordsInput.split(',').map(k => k.trim());

  credentials.jobPreferences.location = await question('Enter preferred job location: ');
  credentials.jobPreferences.experience = await question('Enter your experience level (e.g., "2-5 years"): ');
  credentials.jobPreferences.salary = await question('Enter salary expectation (optional): ');

  const maxApps = await question('Max applications per session (default 25): ');
  credentials.jobPreferences.maxApplications = parseInt(maxApps) || 25;

  const excludeInput = await question('Keywords to exclude (comma-separated, optional): ');
  if (excludeInput.trim()) {
    credentials.jobPreferences.excludeKeywords = excludeInput.split(',').map(k => k.trim());
  }

  const configDir = path.join(__dirname, 'config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const credentialsPath = path.join(configDir, 'credentials.json');
  fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));

  console.log('\n✅ Credentials saved successfully!');
  console.log('📁 File location:', credentialsPath);
  console.log('🔒 This file is automatically ignored by git for security');

  rl.close();
}

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

setupCredentials().catch(console.error);
