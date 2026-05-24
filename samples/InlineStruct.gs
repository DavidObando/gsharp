// file: InlineStruct.gs
// Phase 7.4 / ADR-0033: 'inline struct' declarations introduce readonly single-field value wrappers for zero-allocation newtypes.

package GSharp.Example.InlineStruct

import System

type UserId inline struct(value string)
type OrderId inline struct(value string)

func printUser(id UserId) {
    let (raw) = id
    Console.WriteLine("UserId(value=" + raw + ")")
}

let user = UserId("u-1")
let sameUser = UserId("u-1")
let order = OrderId("o-1")
let echoed = user
let (rawUser) = user
let (rawOrder) = order

printUser(user)
Console.WriteLine(user == sameUser)
Console.WriteLine(user != echoed)
Console.WriteLine(rawUser)
Console.WriteLine(rawOrder)
