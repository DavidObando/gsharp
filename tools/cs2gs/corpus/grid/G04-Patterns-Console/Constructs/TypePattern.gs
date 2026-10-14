// inventory: TypePattern

package Corpus.Grid04.Constructs

import System

shared class TypePatternFixture {
    func Run() {
        let number object = 42
        let classifyNumber = switch number {
            case _ is int32: "int"
            case _ is string: "string"
            default: "other"
        }
        Console.WriteLine("TypePattern: switch($classifyNumber) = int expected")
        let text object = "hi"
        if text is string {
            Console.WriteLine("TypePattern: is-test string match")
        }
        switch number {
            case _ is int32 {
                Console.WriteLine("TypePattern: switch-statement int match")
            }
            default {
                Console.WriteLine("TypePattern: switch-statement default")
            }
        }
        let whole object = 7L
        let classifyWhole = switch whole {
            case _ is int32 or _ is int64: "whole number"
            default: "other"
        }
        Console.WriteLine("TypePattern: or-combinator switch($classifyWhole) = whole number expected")
    }
}
