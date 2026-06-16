// file: InterfaceUpcast.gs
//
// Phase D (close interpreter/emit gap): class → interface reference
// upcast. The CLR satisfies the contract at the reference level so emit
// only needs to recognise this as a no-op.

package GSharp.Samples.InterfaceUpcast

import System

interface IGreeter {
    func Greet() string;
}

class English(Name string) : IGreeter {
    func Greet() string {
        return "Hello, $Name"
    }
}

class Spanish(Name string) : IGreeter {
    func Greet() string {
        return "Hola, $Name"
    }
}

// Implicit upcast: local typed as the interface accepts a Class instance.
var g IGreeter = English("World")
Console.WriteLine(g.Greet())
g = Spanish("Mundo")
Console.WriteLine(g.Greet())

// Implicit upcast in argument position.
func shout(x IGreeter) {
    Console.WriteLine(x.Greet() + "!")
}

shout(English("Ada"))
shout(Spanish("Eva"))
