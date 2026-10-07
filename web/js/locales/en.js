// Dictionnaire anglais : fusion des fichiers par zone de l'interface.
import core from './en/core.js';
import devices from './en/devices.js';
import home from './en/home.js';
import imp from './en/import.js';

export default { ...core, ...devices, ...home, ...imp };
