package ProjectRefLib

import System

class Greeter(Name string) {
    func Greet() string {
        return "Hello, " + Name + "!"
    }
}
