# Bundled MIB modules

Standard MIB modules the add-on reads at startup (`src/mib.js`), so the SNMP
"All data" view can name standard objects and show their values with units
and enumerations. A module uploaded on the Settings page replaces the bundled
one of the same name.

They are unmodified copies of the published modules:

- IETF and IANA modules (from the RFCs and IANA registries), as distributed
  with net-snmp and libsmi. The MIB modules in RFCs are code components that
  may be redistributed.
- net-snmp's own modules (`NET-SNMP-*`, `UCD-*`), under net-snmp's BSD-style
  licence.
- `LLDP-MIB`, published by the IEEE 802.1 working group (802.1AB).

To add one: drop the file in this directory (any name; the module name is read
from the text) and make sure what it imports is here too. Vendor MIBs belong
in the MIB library (Settings), not here.
