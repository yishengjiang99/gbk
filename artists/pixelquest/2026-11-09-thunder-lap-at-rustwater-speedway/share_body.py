import json;p=json.load(open('project.json'));p['name']='Thunder Lap at Rustwater Speedway'
json.dump({"title":"Thunder Lap at Rustwater Speedway","project":p,"public":True},open('share_body.json','w'))
