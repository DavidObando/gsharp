package ProjectRefLib

import System

type Greeter class(Name string) {
    func Greet() string {
        return "Hello, " + Name + "!"
    }
}
