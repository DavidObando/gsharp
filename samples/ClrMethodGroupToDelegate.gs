// file: ClrMethodGroupToDelegate.gs
// Issue #337: a CLR member method group converts directly to a delegate value,
// mirroring the named-function method-group support from #324/#332. This
// sample exercises every supported shape:
//   * a static member group on an imported type (Console.WriteLine, Int32.Parse),
//   * an instance member group that captures its receiver (StringBuilder.Append),
//   * overload selection driven by the target delegate signature.

package GSharp.Example.ClrMethodGroupToDelegate

import System
import System.Text

// Static member method group -> Action[string] (void return). Overload
// selection picks WriteLine(string) among Console.WriteLine's many overloads.
var write Action[string] = Console.WriteLine
write.Invoke("hello from a static method group")

// Static member method group -> Func[string, int32]. Int32.Parse(string) is
// selected by the target signature.
var parse Func[string, int32] = Int32.Parse
Console.WriteLine(parse.Invoke("41") + 1)

// Instance member method group -> Func[string, StringBuilder]. The receiver
// `sb` is captured as the delegate target; Append(string) is selected.
var sb = StringBuilder()
var append Func[string, StringBuilder] = sb.Append
append.Invoke("instance ")
append.Invoke("method ")
append.Invoke("group")
Console.WriteLine(sb.ToString())
