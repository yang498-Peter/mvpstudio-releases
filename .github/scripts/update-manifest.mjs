import fs from 'node:fs';

const MANIFEST_PATH = 'updates.json';
const repository = String(process.env.GITHUB_REPOSITORY || '').trim();
const token = String(process.env.GITHUB_TOKEN || '').trim();

function readEvent() {
  const eventPath = String(process.env.GITHUB_EVENT_PATH || '').trim();
  if (!eventPath || !fs.existsSync(eventPath)) return {};
  return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
}

async function githubApi(pathname) {
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required for API lookup.');
  const response = await fetch(`https://api.github.com/repos/${repository}${pathname}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mvpstudio-release-manifest',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function resolveRelease() {
  const event = readEvent();
  if (event.release) return event.release;
  const tag = String(process.env.RELEASE_TAG || event.inputs?.release_tag || '').trim();
  if (!tag) throw new Error('A published release event or RELEASE_TAG is required.');
  return githubApi(`/releases/tags/${encodeURIComponent(tag)}`);
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return { schemaVersion: 1, generatedAt: null, channels: { stable: null, preview: null } };
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (manifest?.schemaVersion !== 1 || !manifest.channels || typeof manifest.channels !== 'object') {
    throw new Error('updates.json has an unsupported schema.');
  }
  return manifest;
}

function selectInstaller(assets) {
  const installers = assets.filter(asset => /^MVPStudio-Setup-.*\.exe$/i.test(String(asset.name || '')));
  if (installers.length !== 1) {
    throw new Error(`Expected exactly one MVPStudio-Setup-*.exe asset; found ${installers.length}.`);
  }
  const installer = installers[0];
  const checksumName = `${installer.name}.sha256`;
  const checksum = assets.find(asset => String(asset.name || '').toLowerCase() === checksumName.toLowerCase());
  if (!checksum) throw new Error(`Missing checksum asset: ${checksumName}`);
  return { installer, checksum };
}

const release = await resolveRelease();
if (release.draft || !release.published_at) throw new Error('Only a published, non-draft release can update the manifest.');
const parsedVersion = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(String(release.tag_name || ''));
if (!parsedVersion) throw new Error(`Release tag is not valid SemVer: ${release.tag_name}`);

const { installer, checksum } = selectInstaller(Array.isArray(release.assets) ? release.assets : []);
const version = `${parsedVersion[1]}.${parsedVersion[2]}.${parsedVersion[3]}${parsedVersion[4] ? `-${parsedVersion[4]}` : ''}`;
const channel = release.prerelease ? 'preview' : 'stable';
const manifest = loadManifest();
manifest.generatedAt = new Date().toISOString();
manifest.channels.stable ??= null;
manifest.channels.preview ??= null;
manifest.channels[channel] = {
  version,
  tag: String(release.tag_name),
  name: String(release.name || `MVPStudio ${version}`),
  releaseUrl: String(release.html_url),
  publishedAt: String(release.published_at),
  mandatory: false,
  installer: {
    name: String(installer.name),
    url: String(installer.browser_download_url),
    size: Number(installer.size),
    checksumUrl: String(checksum.browser_download_url),
  },
};

fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Updated ${channel} channel to ${release.tag_name}.`);
