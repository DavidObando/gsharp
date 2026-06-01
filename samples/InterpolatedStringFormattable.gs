// file: InterpolatedStringFormattable.gs
// ADR-0055 Tier 4 conformance fixture: an interpolated string whose contextual
// target type is `FormattableString` lowers to
// `FormattableStringFactory.Create(format, args)` instead of an eager `string`.
// Formatting is deferred, so the caller chooses the culture via
// `ToString(IFormatProvider)`. Alignment (`,4`) and format (`:N2`) specifiers
// are preserved in the synthesized composite format string, and the same
// `FormattableString` renders differently under different cultures.
//
// The fixture also covers #369's deferred item: an interpolation passed
// *directly as a call argument* whose parameter type is `FormattableString`
// is target-typed to `FormattableStringFactory.Create` rather than a `string`.

package InterpolatedStringFormattable

import System
import System.Globalization

func renderInvariant(fs FormattableString) string {
    return fs.ToString(CultureInfo.InvariantCulture)
}

let total = 1234.5
let qty = 7
let fs FormattableString = "amount: ${total:N2} (x${qty,4})"

Console.WriteLine(fs.ToString(CultureInfo.InvariantCulture))
Console.WriteLine(fs.ToString(CultureInfo.GetCultureInfo("de-DE")))

// Argument-position target typing: the interpolation below is the argument to a
// `FormattableString` parameter, so it lowers to a deferred FormattableString.
Console.WriteLine(renderInvariant("qty=${qty,4} total=${total:N2}"))
