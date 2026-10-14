// inventory: OperatorDeclaration — user-defined +, ==/!=, < and > operators
// Issue #1917 (fixed): an Equals(object) override using `obj is Money other &&
// ...` used to compile but fail ilverify (StackUnexpected: found address of
// 'object', expected readonly address of 'Money' in Money::Equals). The
// struct field-access emitter took the address of the ORIGINAL `object`-typed
// parameter slot instead of unboxing the smart-cast-narrowed value first. See
// MethodBodyEmitter.TryLoadStructVariableAddress.

package Corpus.Grid07

import System

struct Money {
    private let _cents int32

    init(cents int32) {
        _cents = cents
    }

    func Cents() int32 {
        return _cents
    }

    override func Equals(obj object?) bool {
        return obj is Money other && _cents == other._cents
    }

    override func GetHashCode() int32 {
        return _cents.GetHashCode()
    }
}

func (left Money) operator + (right Money) Money {
    return Money(left._cents + right._cents)
}

func (left Money) operator == (right Money) bool {
    return left._cents == right._cents
}

func (left Money) operator != (right Money) bool {
    return left._cents != right._cents
}

func (left Money) operator < (right Money) bool {
    return left._cents < right._cents
}

func (left Money) operator > (right Money) bool {
    return left._cents > right._cents
}

shared class OperatorDeclarationFixture {
    func Run() {
        let five = Money(500)
        let three = Money(300)
        var eight = five + three
        Console.WriteLine("OperatorDeclaration: plus=" + eight.Cents().ToString())
        Console.WriteLine(
            "OperatorDeclaration: equal=" +
                (
                if eight == Money(800) {
                    "true"
                } else {
                    "false"
                }
            )
        )
        Console.WriteLine(
            "OperatorDeclaration: not-equal=" +
                (
                if five != three {
                    "true"
                } else {
                    "false"
                }
            )
        )
        Console.WriteLine(
            "OperatorDeclaration: less=" +
                (
                if three < five {
                    "true"
                } else {
                    "false"
                }
            )
        )
        Console.WriteLine(
            "OperatorDeclaration: greater=" +
                (
                if three > five {
                    "true"
                } else {
                    "false"
                }
            )
        )
        let boxedEight object = eight
        Console.WriteLine(
            "OperatorDeclaration: equals-override=" +
                (
                if boxedEight.Equals(Money(800)) {
                    "true"
                } else {
                    "false"
                }
            )
        )
        Console.WriteLine(
            "OperatorDeclaration: equals-override-mismatch=" +
                (
                if boxedEight.Equals("not money") {
                    "true"
                } else {
                    "false"
                }
            )
        )
    }
}
