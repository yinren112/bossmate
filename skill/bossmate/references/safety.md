# Safety and privacy

## Hard stops

Stop all online actions for the affected account when any of these appears:

- code 36 or 37;
- CAPTCHA, security verification, or account anomaly;
- repeated empty or partial JD content;
- job, company, recruiter, or recipient mismatch;
- uncertain message delivery;
- unexpected browser navigation or lost login.

Do not retry through a different browser surface, account, internal API, or automation framework.

## Send gates

Require all of the following:

1. complete structured JD;
2. configured requirements reviewed with evidence;
3. no prior conversation with the recruiter;
4. current page still matches the reviewed job and JD hash;
5. opener uses only confirmed facts;
6. review-mode approval or configured autopilot mode;
7. exact recipient identity;
8. exact message row shows delivered/read.

The runtime has no force-send option. Do not add one.

## Privacy

Keep these out of the Skill and source control:

- resume and identity details;
- `profile.md` and `preferences.json`;
- live ledger and reports;
- browser profile, cookies, session files, and screenshots;
- recruiter chats and contact information.

Never send private data to another model or service unless the user explicitly asks and understands the destination.

## Public communication

Describe the project as local browser assistance with evidence and safety gates. Do not claim that it defeats detection, hides automation, bypasses security, or guarantees account safety.
