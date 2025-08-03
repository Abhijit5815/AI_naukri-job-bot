# Naukri Job Application Bot

Automated job application bot for Naukri.com built with TypeScript and Playwright.


https://github.com/user-attachments/assets/3a406422-2d99-4325-b052-43a93c2d576e





## Features

- 🔐 Secure login to Naukri.com
- 🔍 Smart job search based on your preferences
- 🎯 Automated job applications
- 🚫 Keyword exclusion filters
- 📊 Application tracking and reporting
- 🔒 Secure credential storage
- 🤖 Human-like behavior with delays
- 🛡️ Duplicate application prevention
- ⚡ Fast and reliable automation

## Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Active Naukri.com account

## Setup Instructions

### 1. Clone or Download the Project


### 2. Install Dependencies


### 3. Set Up Your Credentials

**Option A: Interactive Setup (Recommended)**

**Option B: Manual Setup**

### 4. Configure Your Job Preferences

Edit `src/config/credentials.json` with your information:

{
"naukri": {
"email": "your.email@example.com",
"password": "your_password"
},
"jobPreferences": {
"keywords": ["javascript", "typescript", "node.js", "react"],
"location": "Bangalore",
"experience": "2-5 years",
"salary": "5-10 LPA",
"maxApplications": 25,
"excludeKeywords": ["senior", "lead", "manager", "architect"]
}
}


### 5. Run the Bot

Development mode (with TypeScript compilation)
npm run dev

Or build and run production version

npm run build
npm start


## Configuration Options

### Job Preferences

| Field | Description | Example |
|-------|-------------|---------|
| `keywords` | Skills/technologies to search for | `["python", "django", "aws"]` |
| `location` | Preferred job location | `"Mumbai"` |
| `experience` | Your experience level | `"3-6 years"` |
| `salary` | Expected salary range (optional) | `"8-15 LPA"` |
| `maxApplications` | Max applications per session | `25` |
| `excludeKeywords` | Job titles to avoid | `["senior", "lead"]` |

### Example Configurations

**For Fresher/Entry Level:**
{
"keywords": ["html", "css", "javascript", "react"],
"location": "Any",
"experience": "0-2 years",
"maxApplications": 50,
"excludeKeywords": ["senior", "lead", "manager", "3+ years"]
}

**For Mid-Level Developer:**
{
"keywords": ["node.js", "react", "mongodb", "aws"],
"location": "Bangalore",
"experience": "3-6 years",
"salary": "8-15 LPA",
"maxApplications": 30,
"excludeKeywords": ["intern", "trainee", "junior"]
}

**For Senior Developer:**
{
"keywords": ["microservices", "kubernetes", "system design"],
"location": "Hyderabad",
"experience": "5-10 years",
"salary": "15-30 LPA",
"maxApplications": 20,
"excludeKeywords": ["junior", "associate", "trainee"]
}


## How It Works

1. **Login Process**
   - Opens browser and navigates to Naukri.com
   - Logs in with your credentials
   - Validates successful authentication

2. **Job Search**
   - Searches based on your keywords and location
   - Applies experience and salary filters
   - Counts total matching jobs

3. **Application Process**
   - Iterates through job listings
   - Filters out excluded keywords
   - Clicks apply buttons automatically
   - Handles confirmation dialogs
   - Tracks applied jobs to prevent duplicates

4. **Progress Tracking**
   - Real-time console logging
   - Application counter
   - Success/failure reporting
   - Final summary with applied job list

## Available Commands

Interactive credential setup
npm run setup

Run in development mode
npm run dev

Build TypeScript to JavaScript
npm run build

Run built version
npm start

Clean build
npm run clean # (if you add this script)


## Project Structure

naukri-job-bot/
├── src/
│ ├── config/
│ │ ├── credentials.template.json # Template file (safe to commit)
│ │ └── credentials.json # Your actual credentials (ignored by git)
│ ├── server.ts # MCP server with Playwright automation
│ ├── naukri-client.ts # Main application client
│ └── setup.ts # Interactive setup script
├── dist/ # Compiled JavaScript (auto-generated)
├── package.json # Project dependencies and scripts
├── tsconfig.json # TypeScript configuration
├── .gitignore # Files to ignore in version control
└── README.md # This file


## Safety Features

- **Rate Limiting**: Adds delays between actions to appear human-like
- **Error Handling**: Continues operation if individual jobs fail
- **Duplicate Prevention**: Won't apply to the same job twice
- **Configurable Limits**: Set maximum applications per session
- **Keyword Filtering**: Automatically skips unwanted job types
- **Browser Visibility**: Runs in visible mode for monitoring

## Security

- ✅ **Credentials are secure**: `credentials.json` is automatically ignored by git
- ✅ **Local storage only**: No data sent to external servers
- ✅ **Template provided**: Safe template file for sharing project
- ❌ **Never commit credentials**: The actual credentials.json file is never tracked

## Troubleshooting

### Common Issues

**1. Browser won't start**

npx playwright install --force


**2. Login fails**
- Verify your email and password in `credentials.json`
- Check if Naukri requires 2FA (not currently supported)
- Ensure no special characters causing JSON parsing issues

**3. No jobs found**
- Try broader keywords
- Check if location is spelled correctly
- Verify experience range format

**4. Applications not working**
- Some jobs may require manual application
- Premium/featured jobs might have different UI
- Rate limiting may be triggered - reduce `maxApplications`

**5. TypeScript compilation errors**

rm -rf node_modules package-lock.json
npm install


### Debug Mode

To run with more detailed logging:

Set debug environment variable
DEBUG=* npm run dev


## Customization

### Adding New Features

The bot is built with a modular MCP (Model Context Protocol) architecture. You can extend it by:

1. **Adding new tools** in `server.ts`
2. **Modifying job search logic** in the `searchJobs` method
3. **Customizing application flow** in the `applyToJobs` method
4. **Adding new job sites** by creating additional server modules

### Example: Adding LinkedIn Support

You could extend this to support LinkedIn by creating a similar server module and updating the client to handle multiple job sites.

## Performance Tips

- **Start small**: Begin with `maxApplications: 5` to test
- **Monitor activity**: Keep browser visible to watch for issues
- **Peak hours**: Run during off-peak hours for better success rates
- **Regular breaks**: Don't run continuously - space out sessions

## Legal and Ethical Considerations

⚠️ **Important Notes:**

- This tool is for **educational purposes** and personal use
- Respect Naukri.com's terms of service and rate limits
- Use responsibly - quality applications are better than quantity
- Consider manual review of applications for better success rates
- Be prepared to handle responses and interviews professionally

## Contributing

If you want to improve this bot:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review console logs for error messages
3. Verify your configuration files
4. Test with a smaller batch size first

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Changelog

### v1.0.0
- Initial release
- Basic Naukri.com automation
- Secure credential management
- TypeScript implementation
- MCP architecture

---

**Happy job hunting! 🚀**

*Remember: This tool helps automate the application process, but success ultimately depends on your skills, experience, and how well you handle the interview process.*


