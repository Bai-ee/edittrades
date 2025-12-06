# Custody Limit Resources and Next Steps

**Date:** 2025-12-03  
**Status:** Reference Guide

## Quick Reference

### Error Code
- **6023:** `CustodyAmountLimit` - "Custody amount limit exceeded"

### Documentation Links
- [Custody Account Docs](https://dev.jup.ag/docs/perps/custody-account)
- [Position Account Docs](https://dev.jup.ag/docs/perps/position-account)
- [PositionRequest Account Docs](https://dev.jup.ag/docs/perps/position-request-account)

### Code Repositories
- [Jupiter Perpetuals IDL Parsing](https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing)
- [Jupiter Perpetuals IDL JSON](https://raw.githubusercontent.com/julianfssen/jupiter-perps-anchor-idl-parsing/main/src/idl/jupiter-perpetuals-idl-json.json)

### Community Support
- [Jupiter Discord](https://discord.gg/jupiter) - For technical support

## Implementation Status

✅ **Completed:**
- Pre-trade custody capacity checking
- Detailed error messages with limit information
- Custody limit logging and monitoring
- Error detection and handling

## Related Errors

The IDL shows related limit errors:
- **6023:** `CustodyAmountLimit` - Custody account limit exceeded
- **6024:** `PoolAmountLimit` - Pool account limit exceeded
- **6025:** `PersonalPoolAmountLimit` - Personal pool limit exceeded

## Next Steps for Production

1. **Monitor Capacity:** Implement periodic checks of custody capacity
2. **User Notifications:** Alert users when capacity is low
3. **Automatic Retry:** Implement retry logic with smaller sizes
4. **Capacity Dashboard:** Create UI to show available capacity per market


