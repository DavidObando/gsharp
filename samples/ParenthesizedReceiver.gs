// file: ParenthesizedReceiver.gs
// ADR-0054: postfix member/index access applies to any primary expression,
// including parenthesized expressions. This sample exercises member access,
// method calls, indexing, and chained access through a parenthesized receiver
// end-to-end (compile via gsc, run, diff stdout).

package GSharp.Example.ParenthesizedReceiver

import System

let a = 10
let b = 32

Console.WriteLine((a + b).GetType())
Console.WriteLine((a + b).ToString())

let nums = [3]int32{10, 20, 30}
Console.WriteLine((nums)[1])

let s = "hello"
Console.WriteLine((s).Length)
