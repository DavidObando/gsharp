struct Point: Equatable {
    var x: Int32
    var y: Int32
}

func describe(_ point: Point?) -> String {
    guard let known = point else { return "no position" }
    return "\(known.x), \(known.y)"
}

let origin = Point(x: 0, y: 0)
var moved = origin
moved.x = 3
print(describe(moved))
print(describe(nil))
print(origin == Point(x: 0, y: 0))
