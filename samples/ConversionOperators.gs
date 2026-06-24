// file: ConversionOperators.gs
// Issue #1017: user-defined implicit/explicit conversion operators.
// `func operator implicit (x T) U` and `func operator explicit (x T) U`
// emit CLR op_Implicit/op_Explicit and participate in conversion resolution.
package GSharp.Sample.ConversionOperators

import System

struct Celsius {
    var degrees float64
}

struct Fahrenheit {
    var degrees float64
}

// Implicit: a Celsius flows into a float64 wherever one is expected.
func operator implicit (c Celsius) float64 {
    return c.degrees
}

// Explicit: build a Celsius from a float64 with a cast.
func operator explicit (d float64) Celsius {
    return Celsius{degrees: d}
}

// Explicit: convert Celsius to Fahrenheit.
func operator explicit (c Celsius) Fahrenheit {
    return Fahrenheit{degrees: c.degrees * 9.0 / 5.0 + 32.0}
}

func describe(temp float64) float64 {
    return temp
}

let boiling = Celsius{degrees: 100.0}

// Implicit conversion at assignment.
let asFloat float64 = boiling
Console.WriteLine(asFloat)

// Implicit conversion at argument passing.
Console.WriteLine(describe(boiling))

// Explicit conversion via the type-call cast form.
let f = Fahrenheit(boiling)
Console.WriteLine(f.degrees)

// Explicit conversion back from a raw float64.
let freezing = Celsius(0.0)
Console.WriteLine(freezing.degrees)
