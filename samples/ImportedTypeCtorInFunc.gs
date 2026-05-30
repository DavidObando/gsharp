// file: ImportedTypeCtorInFunc.gs
// Regression for issue #293: constructing an imported (CLR) type inside a
// function body must work exactly as at top-level script scope, for both the
// simple-name form (`StringBuilder()`) and the fully-qualified form
// (`System.Text.StringBuilder()`). Static member access on imported types
// already worked inside functions; only construction (and fully-qualified type
// paths in expression position) regressed with GS0130/GS0157.

package GSharp.Samples.ImportedTypeCtorInFunc

import System
import System.Text

// Simple-name construction inside a function body.
func buildSimple() string {
    var sb = StringBuilder()
    sb.Append("simple")
    return sb.ToString()
}

// Fully-qualified construction inside a function body.
func buildQualified() string {
    var sb = System.Text.StringBuilder()
    sb.Append("qualified")
    return sb.ToString()
}

// Construction inside a method body shares the same binding path.
type Joiner class {
    func join() string {
        var sb = System.Text.StringBuilder()
        sb.Append(buildSimple())
        sb.Append("+")
        sb.Append(buildQualified())
        return sb.ToString()
    }
}

Console.WriteLine(buildSimple())
Console.WriteLine(buildQualified())

var j = Joiner{}
Console.WriteLine(j.join())

// The identical construction still works at top level.
var top = System.Text.StringBuilder()
top.Append("toplevel")
Console.WriteLine(top.ToString())
