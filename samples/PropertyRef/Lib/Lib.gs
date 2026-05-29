package PropertyRefLib

import System

// Auto-property (read-write)
type Person class {
    prop Name string
    prop Age int32
}

// Computed property (read-only)
type Rect class {
    prop Width int32
    prop Height int32
    prop Area int32 {
        get { return this.Width * this.Height }
    }
}

// Computed property (read-write) with custom setter parameter
type Clamped class {
    prop raw int32
    prop Value int32 {
        get { return this.raw }
        set(v) {
            if v < 0 { this.raw = 0 }
            else if v > 100 { this.raw = 100 }
            else { this.raw = v }
        }
    }
}

// Virtual and override properties
type Animal open class {
    open prop Sound string {
        get { return "..." }
    }
}

type Dog class : Animal {
    override prop Sound string {
        get { return "Woof" }
    }
}

type Cat class : Animal {
    override prop Sound string {
        get { return "Meow" }
    }
}
