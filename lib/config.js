import fs from 'node:fs'
import YAML from 'yaml'

const configFile = new URL('../config/config.yaml', import.meta.url)

function readYaml (file) {
  return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}
}

export function getAgentConfig () {
  return readYaml(configFile)
}
