// inventory: SwitchStatement

package Corpus.Grid03.Constructs

import System

shared class SwitchStatementFixture {
    func Run() {
        for var day = 1; day <= 8; day++ {
            var kind string
            switch day {
                case 6, 7 {
                    kind = "weekend"
                }
                case 8 {
                    kind = "invalid"
                }
                default {
                    kind = "weekday"
                }
            }
            Console.WriteLine("SwitchStatement: day $day is $kind")
        }
        let colors[]string = []string{"red", "green", "plaid"}
        for color in colors {
            switch color {
                case "red" {
                    Console.WriteLine("SwitchStatement: red means stop")
                }
                case "green" {
                    Console.WriteLine("SwitchStatement: green means go")
                }
                default {
                    Console.WriteLine("SwitchStatement: unknown color $color")
                }
            }
        }
    }
}
