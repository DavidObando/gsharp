using PropertyRefLib;
using System.Text.Json;

// --- Auto-property: read/write ---
var p = new Person();
p.Name = "Alice";
p.Age = 30;
Console.WriteLine($"{p.Name},{p.Age}");

// --- Computed read-only property ---
var r = new Rect();
r.Width = 6;
r.Height = 7;
Console.WriteLine(r.Area);

// --- Computed read-write property with clamping setter ---
var c = new Clamped();
c.Value = 42;
Console.WriteLine(c.Value);
c.Value = -5;
Console.WriteLine(c.Value);
c.Value = 200;
Console.WriteLine(c.Value);

// --- Virtual/override property via base type ---
Animal dog = new Dog();
Animal cat = new Cat();
Console.WriteLine(dog.Sound);
Console.WriteLine(cat.Sound);

// --- Object initializer syntax ---
var p2 = new Person { Name = "Bob", Age = 25 };
Console.WriteLine($"{p2.Name},{p2.Age}");

// --- System.Text.Json serialization round-trip ---
var original = new Person { Name = "Carol", Age = 40 };
var json = JsonSerializer.Serialize(original);
var deserialized = JsonSerializer.Deserialize<Person>(json)!;
Console.WriteLine($"{deserialized.Name},{deserialized.Age}");
