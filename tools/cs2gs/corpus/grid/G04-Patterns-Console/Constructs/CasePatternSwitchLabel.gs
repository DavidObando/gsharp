// inventory: CasePatternSwitchLabel

package Corpus.Grid04.Constructs

import System

shared class CasePatternSwitchLabelFixture {
    func Run() {
        let inputs[]object? = []object? {5, 42, "hello", nil, 3.5}
        for item in inputs {
            switch item {
                case n is int32 when n > 10 {
                    Console.WriteLine("CasePatternSwitchLabel: big int $n")
                }
                case n is int32 {
                    Console.WriteLine("CasePatternSwitchLabel: small int $n")
                }
                case s is string {
                    Console.WriteLine("CasePatternSwitchLabel: string of length ${s.Length}")
                }
                case nil {
                    Console.WriteLine("CasePatternSwitchLabel: null input")
                }
                default {
                    Console.WriteLine("CasePatternSwitchLabel: something else")
                }
            }
        }
    }
}
