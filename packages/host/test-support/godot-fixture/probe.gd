extends SceneTree

func _initialize():
    # Start with the scene: the dependency must resolve without preloading it.
    var scene = ResourceLoader.load("res://sample.tscn") as PackedScene
    if scene == null:
        quit(1)
        return
    var sprite = scene.instantiate() as Sprite2D
    var texture = ResourceLoader.load("res://sample.svg") as Texture2D
    if sprite == null or texture == null or sprite.texture != texture or texture.get_size() != Vector2(3, 5):
        quit(2)
        return
    sprite.free()
    print("SCENE_AND_TEXTURE_OK")
    quit(0)
