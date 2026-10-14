// L1-Console: the simplest corpus level. A deterministic console program whose
// stdout is the parity oracle (no timestamps / random / GUIDs).
//
// Exercises (ADR-0115 section B):
//   B.1  namespace + System usage
//   B.2  brace/indent style
//   B.3  local var / const, never-reassigned vs reassigned locals
//   B.4  a plain reference class
//   B.5  in-body instance methods on an owned type
//   B.6  field declarations with a constructor
//   B.9  string interpolation, including a format specifier and a literal '$'
//
// Note: this file intentionally uses ordinary C# style (underscore-prefixed
// private fields, no StyleCop file header, implicit `this`). If the repo-shared
// StyleCop + TreatWarningsAsErrors leaked in, this would fail to build - so a
// clean build proves the corpus isolation works.

package Corpus.L1

import System
import System.Collections.Generic

internal class Cart {
    private let _customer string
    private let _items List[(Name string, Price int32, Quantity int32)]

    init(customer string) {
        _customer = customer
        _items = List[(string, int32, int32)]()
    }

    func Add(name string, price int32, quantity int32) {
        _items.Add((name, price, quantity))
    }

    func Subtotal() int32 {
        var total = 0
        for item in _items {
            total += item.Price * item.Quantity
        }
        return total
    }

    prop LineCount int32 -> _items.Count

    func PrintReceipt() {
        const taxPercent = 8
        Console.WriteLine("Receipt for $_customer")
        Console.WriteLine("----------------------")
        var index = 1
        for item in _items {
            let lineTotal = item.Price * item.Quantity
            Console.WriteLine("$index. ${item.Name} x${item.Quantity} @ ${item.Price} = $lineTotal")
            index++
        }
        let subtotal = Subtotal()
        let tax = (subtotal * taxPercent) / 100
        let grandTotal = subtotal + tax
        Console.WriteLine("----------------------")
        Console.WriteLine("Subtotal: $subtotal")
        Console.WriteLine("Tax ($taxPercent%): $tax")
        Console.WriteLine("Total: $grandTotal")
    }
}

private func PrintFizzBuzz(upTo int32) {
    var n = 1
    while n <= upTo {
        var label string
        if n % 15 == 0 {
            label = "FizzBuzz"
        } else if n % 3 == 0 {
            label = "Fizz"
        } else if n % 5 == 0 {
            label = "Buzz"
        } else {
            label = n.ToString()
        }
        Console.WriteLine("$n -> $label")
        n++
    }
    var evens = 0
    for var i = 1; i <= upTo; i++ {
        if i % 2 == 0 {
            evens++
        }
    }
    Console.WriteLine("Evens from 1..$upTo: $evens")
}

let cart = Cart("Ada")
cart.Add("Notebook", 5, 3)
cart.Add("Pen", 2, 4)
cart.Add("Marker", 3, 2)
cart.PrintReceipt()
Console.WriteLine()
PrintFizzBuzz(15)
Console.WriteLine()
Console.WriteLine("Items in cart: ${cart.LineCount}")
Console.WriteLine("Greeting uses a literal dollar sign: $$5 each")
